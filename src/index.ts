#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'url';
import express from 'express';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

// Helper to break type inference chain and avoid "Type instantiation is excessively deep" errors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (schema: any): Record<string, unknown> =>
  zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig } from './config.js';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { tools } from './tools.js';
import { GitLabOAuthProvider, buildOAuthOptions, createOAuthStore } from './oauth.js';

// Single source of truth for the server version: read package.json at runtime so
// it never drifts from the published package. Resolves to the repo root in both
// dev (src/index.ts) and build (dist/index.js) layouts.
const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * Idempotently tear down one HTTP session and close its server.
 *
 * The MCP SDK wires `server.close()` -> `transport.close()` -> `transport.onclose`,
 * so the close handler re-enters itself. We therefore remove the session from the map
 * BEFORE closing its server: the first call deletes the entry and closes the server;
 * any re-entrant call finds no entry and returns immediately. This breaks the recursion
 * that otherwise produced a `RangeError: Maximum call stack size exceeded` storm and a
 * "remaining sessions" counter that walked past zero into negative numbers.
 */
export function closeHttpSession<T extends { server: { close(): Promise<unknown> } }>(
  sessions: Map<string, T>,
  sessionId: string | undefined,
): void {
  if (!sessionId) return;
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return; // already torn down, or a re-entrant close() — no-op
  sessions.delete(sessionId); // remove FIRST so the re-entrant close is a no-op
  console.error(`[MCP] Session ${sessionId} closed (remaining sessions: ${sessions.size})`);
  void sessionData.server.close().catch(() => {});
}

/**
 * Parse the TRUST_PROXY env var into an Express `trust proxy` value.
 * Returns undefined (don't trust) when unset/empty. Recognizes booleans, a hop
 * count, and otherwise passes the string through (Express accepts IP/subnet lists).
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  const lower = v.toLowerCase();
  if (['true', 'yes', 'on'].includes(lower)) return true;
  if (['false', 'no', 'off'].includes(lower)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

class GitLabMCPServer {
  private server: Server | null = null; // Used only for stdio mode
  private gitlabClient!: GitLabGraphQLClient;
  private httpSessions: Map<string, {
    server: Server;
    transport: StreamableHTTPServerTransport;
    userConfig?: { accessToken: string; gitlabUrl?: string };
    lastActivity: number;
  }> = new Map();
  private sessionCleanupInterval?: NodeJS.Timeout;
  private oauthProvider?: GitLabOAuthProvider;

  constructor() {
    // Initialize GitLab client using environment configuration
    const config = loadConfig();
    this.gitlabClient = new GitLabGraphQLClient(config);

    // Log configuration on startup (for debugging)
    if (process.env.NODE_ENV !== 'production') {
      const tokenLabel = config.token
        ? 'GITLAB_TOKEN (full access)'
        : config.readToken
          ? 'GITLAB_READ_TOKEN (read-only)'
          : 'none (per-call user credentials required for every operation)';
      console.error('[MCP] Configuration loaded:');
      console.error(`  GitLab URL: ${config.gitlabUrl}`);
      console.error(`  Fallback token: ${tokenLabel}`);
      console.error(`  Max page size: ${config.maxPageSize}`);
      console.error(`  Timeout: ${config.defaultTimeout}ms`);
    }
  }

  /**
   * Create a new MCP Server instance with all handlers configured
   */
  private createServer(): Server {
    const server = new Server(
      {
        name: 'GitLab',
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    this.setupToolHandlers(server);
    this.setupPromptHandlers(server);

    server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    return server;
  }

  private setupToolHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map(tool => ({
          name: tool.name,
          ...(tool.title && { title: tool.title }),
          description: tool.description,
          inputSchema: toJsonSchema(tool.inputSchema),
          ...(tool.outputSchema && { outputSchema: toJsonSchema(tool.outputSchema) }),
          ...(tool.annotations && { annotations: tool.annotations }),
          ...(tool.icon && { icon: tool.icon }),
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;

      const tool = tools.find(t => t.name === name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
      }

      try {
        const validatedInput = tool.inputSchema.parse(args || {});

        // Extract user credentials: prioritize args, then OAuth identity, then
        // session-specific config.
        let userConfig = validatedInput.userCredentials;

        // OAuth mode: requireBearerAuth validated the MCP bearer and the broker
        // stashed the per-user GitLab token in authInfo.extra. The StreamableHTTP
        // transport surfaces it as extra.authInfo. This is the spec-correct path —
        // the GitLab token never leaves the server as a client-visible credential.
        if (!userConfig) {
          const gitlabToken = (extra?.authInfo?.extra as { gitlabToken?: string } | undefined)?.gitlabToken;
          if (gitlabToken) {
            userConfig = { accessToken: gitlabToken };
          }
        }

        // If no credentials yet, try to get from session context.
        // The MCP SDK exposes the transport session id at extra.sessionId
        // (top-level), not under extra._meta — see RequestHandlerExtra in
        // @modelcontextprotocol/sdk/shared/protocol.d.ts.
        if (!userConfig && extra?.sessionId) {
          const sessionData = this.httpSessions.get(extra.sessionId as string);
          if (sessionData?.userConfig) {
            userConfig = sessionData.userConfig;
          }
        }

        delete validatedInput.userCredentials; // Remove from input to avoid passing to handler

        const result = await tool.handler(validatedInput, this.gitlabClient, userConfig);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof Error) {
          throw new McpError(ErrorCode.InternalError, error.message);
        }
        throw new McpError(ErrorCode.InternalError, 'Unknown error occurred');
      }
    });
  }

  private setupPromptHandlers(server: Server): void {
    type PromptArg = { name: string; description: string };
    type PromptDef = {
      name: string;
      title: string;
      description: string;
      // All arguments are OPTIONAL by design: some MCP clients (Claude Desktop)
      // fail to attach a prompt when it declares required arguments, because the
      // argument-collection step is brittle. Each render() degrades gracefully —
      // it uses an argument when present and otherwise tells the model to ask.
      args: PromptArg[];
      render: (a: Record<string, string | undefined>) => string;
    };

    // Helper: "for project X" when provided, else an instruction to determine it.
    const forProject = (p?: string) =>
      p && p.trim()
        ? `the GitLab project "${p.trim()}"`
        : 'the relevant GitLab project (ask me for the full path, e.g. "group/project", if it is not obvious from context)';
    const windowDays = (d?: string) => {
      const n = d && /^\d+$/.test(d.trim()) ? parseInt(d.trim()) : 14;
      return n;
    };

    const prompts: PromptDef[] = [
      {
        name: 'explore-project',
        title: 'Explore Project',
        description: 'Overview of a GitLab project: description, recent issues/MRs, and structure',
        args: [{ name: 'projectPath', description: 'Full path, e.g. "group/project" (optional)' }],
        render: (a) => `Please explore ${forProject(a.projectPath)}. Show me:
1. Project overview and description
2. Recent issues (last 10)
3. Recent merge requests (last 10)
4. Repository structure (browse the root directory)

Provide direct links to all resources you find.`,
      },
      {
        name: 'find-my-work',
        title: 'Find My Work',
        description: 'Issues and merge requests assigned to you, plus recent activity',
        args: [],
        render: () => `Please find all issues and merge requests assigned to me:
1. Open issues assigned to me
2. Open merge requests where I'm assigned or a reviewer
3. Recently closed items from the last week
4. My to-do inbox

Provide direct links to each item and summarize what needs my attention first.`,
      },
      {
        name: 'review-merge-request',
        title: 'Review Merge Request',
        description: 'Review a specific merge request — status, diffs, related issues, approvals',
        args: [
          { name: 'projectPath', description: 'Full path, e.g. "group/project" (optional)' },
          { name: 'mrIid', description: 'Merge request IID number (optional)' },
        ],
        render: (a) => {
          const mr = a.mrIid && a.mrIid.trim() ? `merge request !${a.mrIid.trim()}` : 'the merge request I specify';
          return `Please review ${mr} in ${forProject(a.projectPath)}.${a.mrIid ? '' : ' Ask me which MR (project path + IID) if it is not clear.'} Show me:
1. Title, description, and status
2. Source and target branches
3. Changed files and diffs
4. Related issues
5. Review comments and approval status

Provide the direct link and flag any concerns or next steps.`;
        },
      },
      {
        name: 'team-activity',
        title: 'Team Activity Summary',
        description: 'Summarize recent activity across a GitLab group — who did what, where',
        args: [
          { name: 'groupPath', description: 'Group full path, e.g. "group" or "group/subgroup" (optional)' },
          { name: 'days', description: 'Look-back window in days (optional, default 14)' },
        ],
        render: (a) => {
          const scope = a.groupPath && a.groupPath.trim() ? `the "${a.groupPath.trim()}" group` : 'the relevant group (ask me which group if unclear)';
          return `Summarize team activity in ${scope} over the last ${windowDays(a.days)} days:
1. Use the group/user/project event feeds to gather pushes, MRs, issues, comments, and approvals
2. Break it down by person — what each contributor worked on
3. Call out notable merges, opened/closed issues, and review activity
4. Note anyone who's been quiet or any stalled work

Provide direct links and a concise per-person summary.`;
        },
      },
      {
        name: 'user-activity',
        title: "Teammate's Activity (Standup)",
        description: "Recap what a specific teammate has been working on recently",
        args: [
          { name: 'username', description: 'GitLab username (optional)' },
          { name: 'days', description: 'Look-back window in days (optional, default 14)' },
        ],
        render: (a) => {
          const who = a.username && a.username.trim() ? `@${a.username.trim()}` : 'the teammate I name (ask me for their username)';
          return `Give me a standup-style recap of what ${who} has done in the last ${windowDays(a.days)} days:
1. Their activity feed — commits/pushes, MRs opened and merged, issues touched, comments
2. What they're currently assigned (open issues and MRs)
3. Anything blocked or awaiting review

Group by project and provide direct links.`;
        },
      },
      {
        name: 'triage-issues',
        title: 'Triage Issues',
        description: 'Find and prioritize open issues in a project, optionally by label',
        args: [
          { name: 'projectPath', description: 'Full path, e.g. "group/project" (optional)' },
          { name: 'label', description: 'Filter to a label, e.g. "bug" (optional)' },
        ],
        render: (a) => `Help me triage open issues in ${forProject(a.projectPath)}${a.label && a.label.trim() ? `, filtered to the "${a.label.trim()}" label` : ''}:
1. List open issues (most recently updated first)
2. Group by label/priority and highlight anything unassigned or stale
3. Surface issues with recent discussion that may need a decision

Provide direct links and suggest a priority order.`,
      },
      {
        name: 'project-health',
        title: 'Project Health Check',
        description: 'CI/CD, merge-request, and issue health snapshot for a project',
        args: [{ name: 'projectPath', description: 'Full path, e.g. "group/project" (optional)' }],
        render: (a) => `Give me a health snapshot of ${forProject(a.projectPath)}:
1. Open merge requests — how many, any stale or long-open, pipeline status
2. Recent pipeline outcomes (failures vs passes)
3. Open issues volume and trend
4. Anything that looks stuck or needs attention

Summarize the overall state with direct links to the most important items.`,
      },
      {
        name: 'search-gitlab',
        title: 'Search GitLab',
        description: 'Run a guided search across projects, issues, and merge requests',
        args: [{ name: 'query', description: 'What to search for (optional)' }],
        render: (a) => `Search GitLab for ${a.query && a.query.trim() ? `"${a.query.trim()}"` : 'the term I provide (ask me what to search for)'}:
1. Matching projects
2. Matching issues (open and recently closed)
3. Matching merge requests

Provide direct links and a brief summary of the most relevant results.`,
      },
    ];

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: prompts.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        // Declared optional (required omitted) so attachment never blocks on input.
        arguments: p.args.map((arg) => ({ name: arg.name, description: arg.description, required: false })),
      })),
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const def = prompts.find((p) => p.name === name);
      if (!def) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
      }
      return {
        description: def.description,
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: def.render((args ?? {}) as Record<string, string | undefined>) },
          },
        ],
      };
    });
  }

  private setupProcessHandlers(): void {
    process.on('SIGINT', async () => {
      if (this.sessionCleanupInterval) {
        clearInterval(this.sessionCleanupInterval);
      }
      this.oauthProvider?.dispose();
      // Close all HTTP sessions
      for (const [sessionId, data] of this.httpSessions.entries()) {
        try {
          await data.server.close();
        } catch (e) {
          // Ignore errors during shutdown
        }
      }
      this.httpSessions.clear();
      // Close stdio server if running
      if (this.server) {
        await this.server.close();
      }
      process.exit(0);
    });
  }

  /**
   * Start periodic cleanup of inactive sessions
   */
  private startSessionCleanup(): void {
    const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes (reduced from 30)
    const CLEANUP_INTERVAL = 2 * 60 * 1000; // Check every 2 minutes (reduced from 5)

    this.sessionCleanupInterval = setInterval(() => {
      const now = Date.now();
      const expiredSessions: string[] = [];

      for (const [sessionId, data] of this.httpSessions.entries()) {
        if (now - data.lastActivity > SESSION_TIMEOUT) {
          expiredSessions.push(sessionId);
        }
      }

      for (const sessionId of expiredSessions) {
        const data = this.httpSessions.get(sessionId);
        if (data) {
          console.error(`[MCP] Session ${sessionId} expired due to inactivity`);
          data.server.close().catch(() => {});
          data.transport.close().catch(() => {});
          this.httpSessions.delete(sessionId);
        }
      }

      if (expiredSessions.length > 0) {
        console.error(`[MCP] Cleaned up ${expiredSessions.length} expired session(s). Active sessions: ${this.httpSessions.size}`);
      }
    }, CLEANUP_INTERVAL);
  }

  /**
   * Extract and validate user credentials from request headers
   */
  private extractUserCredentials(req: express.Request): { accessToken: string; gitlabUrl?: string } | undefined {
    // In OAuth mode the Authorization header carries our MCP bearer token, not a
    // GitLab PAT — the GitLab identity is resolved by requireBearerAuth and flows
    // through authInfo, so never treat the header as a raw GitLab credential here.
    if (this.oauthProvider) {
      return undefined;
    }
    const authHeader = (req.headers['authorization'] as string) || '';
    const gitlabUrlHeader = (req.headers['x-gitlab-url'] as string) || undefined;

    if (!authHeader) {
      return undefined;
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : authHeader.trim();

    if (!token) {
      return undefined;
    }

    return { accessToken: token, gitlabUrl: gitlabUrlHeader };
  }

  /**
   * Shared handler for Streamable HTTP requests (used by both / and /mcp endpoints)
   */
  private async handleStreamableHTTP(req: express.Request, res: express.Response): Promise<void> {
    try {
      // Validate Accept header per MCP spec
      const acceptHeader = req.headers['accept'] || '';
      const supportsJson = acceptHeader.includes('application/json');
      const supportsSse = acceptHeader.includes('text/event-stream');

      if (!supportsJson && !supportsSse) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Accept header must include application/json or text/event-stream'
          },
          id: null,
        });
        return;
      }

      // Get session ID from header (check both lowercase and capitalized)
      const sessionIdHeader = (req.headers['mcp-session-id'] as string) ||
                             (req.headers['Mcp-Session-Id'] as string) || '';

      if (process.env.NODE_ENV === 'development') {
        console.error(`[MCP] Request: ${req.method} session=${sessionIdHeader || 'none'}`);
      }

      if (sessionIdHeader && this.httpSessions.has(sessionIdHeader)) {
        // Existing session: reuse transport and update credentials
        const sessionData = this.httpSessions.get(sessionIdHeader)!;
        const userConfig = this.extractUserCredentials(req);

        // Update session-specific credentials if provided
        if (userConfig) {
          sessionData.userConfig = userConfig;
        }

        // Update last activity timestamp
        sessionData.lastActivity = Date.now();

        // Don't log every request, only session changes
        await sessionData.transport.handleRequest(req as any, res as any, (req as any).body);
        return;
      }

      // New session initialization
      if (req.method === 'POST') {
        // If we have too many sessions, clean up old ones immediately
        if (this.httpSessions.size > 10) {
          const now = Date.now();
          const oldSessions: string[] = [];

          // Find sessions older than 5 minutes
          for (const [sessionId, data] of this.httpSessions.entries()) {
            if (now - data.lastActivity > 5 * 60 * 1000) {
              oldSessions.push(sessionId);
            }
          }

          // Close and remove old sessions
          for (const sessionId of oldSessions) {
            const data = this.httpSessions.get(sessionId);
            if (data) {
              console.error(`[MCP] Force-closing old session ${sessionId}`);
              data.server.close().catch(() => {});
              data.transport.close().catch(() => {});
              this.httpSessions.delete(sessionId);
            }
          }

          if (oldSessions.length > 0) {
            console.error(`[MCP] Emergency cleanup: removed ${oldSessions.length} old sessions (total now: ${this.httpSessions.size})`);
          }
        }

        // Create a new Server instance for this session
        const server = this.createServer();

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId: string) => {
            const userConfig = this.extractUserCredentials(req);
            this.httpSessions.set(sessionId, {
              server,
              transport,
              userConfig,
              lastActivity: Date.now()
            });
            console.error(`[MCP] Session ${sessionId} initialized with ${userConfig ? 'user' : 'no user'} credentials (total sessions: ${this.httpSessions.size})`);
          },
        });

        transport.onclose = () => {
          closeHttpSession(this.httpSessions, transport.sessionId);
        };

        // Handle errors on the transport
        transport.onerror = (error: Error) => {
          console.error(`[MCP] Transport error for session ${transport.sessionId}:`, error.message);
        };

        await server.connect(transport);
        await transport.handleRequest(req as any, res as any, (req as any).body);
        return;
      }

      // No valid session and not a POST request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided. Initialize with POST request.'
        },
        id: null,
      });
    } catch (error) {
      console.error('[MCP] Error in Streamable HTTP endpoint:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  async run(): Promise<void> {
    try {
      const config = loadConfig();
      
      // Try to introspect schema on startup if we have a fallback token
      if (config.token || config.readToken) {
        try {
          await this.gitlabClient.introspectSchema();
          console.error('GitLab GraphQL schema introspected successfully using fallback token');
        } catch (error) {
          console.error('Warning: Failed to introspect schema with fallback token:', error);
          console.error('Schema will be introspected when user credentials are provided');
        }
      } else {
        console.error('No fallback token configured. Schema will be introspected when user credentials are provided.');
      }
      
      // Determine transport based on environment
      const port = process.env.GITLAB_MCP_PORT ? parseInt(process.env.GITLAB_MCP_PORT) : null;
      const useHttp = process.env.MCP_TRANSPORT === 'http';
      
      if (useHttp && port) {
        // Streamable HTTP transport for LibreChat and modern MCP clients
        const app = express();

        // Disable X-Powered-By header
        app.disable('x-powered-by');

        // Trust the reverse proxy (e.g. traefik) when hosted behind one, so req.ip
        // and the SDK OAuth endpoints' per-IP rate limiting use the real client IP
        // from X-Forwarded-For instead of the proxy's. Without this, every client
        // shares the proxy IP and the shared /register limit can lock everyone out.
        // TRUST_PROXY: a hop count ("1"), boolean ("true"/"false"), or an Express
        // trust-proxy string (e.g. "loopback, uniquelocal"). Unset → not trusted.
        const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
        if (trustProxy !== undefined) {
          app.set('trust proxy', trustProxy);
        }

        // Parse JSON bodies - but NOT for /message endpoint (SSE transport needs raw stream)
        app.use((req, res, next) => {
          if (req.path === '/message') {
            // Skip JSON parsing for SSE message endpoint
            next();
          } else {
            express.json()(req, res, next);
          }
        });

        // CORS and headers
        app.use((req, res, next) => {
          res.header('Access-Control-Allow-Origin', '*');
          res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
          res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-GitLab-Url, Mcp-Session-Id, Accept, Last-Event-ID, Cache-Control');
          res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
          res.header('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION);

          // Disable buffering for SSE streams
          if (req.headers.accept?.includes('text/event-stream')) {
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
          }

          if (req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
          }
          next();
        });

        // OAuth 2.1 brokered auth (optional). When GITLAB_MCP_OAUTH is enabled the
        // server becomes its own Authorization Server in front of GitLab: it
        // advertises protected-resource + AS metadata, supports Dynamic Client
        // Registration, and gates the MCP endpoints behind a validated bearer token.
        const mcpGuards: express.RequestHandler[] = [];
        if (process.env.GITLAB_MCP_OAUTH && /^(1|true|yes|on)$/i.test(process.env.GITLAB_MCP_OAUTH)) {
          const oauthOptions = buildOAuthOptions({
            gitlabUrl: config.gitlabUrl,
            serverUrl: process.env.MCP_SERVER_URL,
            clientId: process.env.GITLAB_OAUTH_CLIENT_ID,
            clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET,
            scopes: process.env.GITLAB_OAUTH_SCOPES,
            callbackPath: process.env.GITLAB_OAUTH_CALLBACK_PATH,
            allowedGroups: process.env.GITLAB_OAUTH_ALLOWED_GROUPS,
            timeoutMs: config.defaultTimeout,
          });
          const issuerUrl = new URL(oauthOptions.serverUrl);
          // Shared state store: Redis when REDIS_URL is set (survives redeploys,
          // enables >1 replica), else in-memory. Namespaced by issuer host so
          // co-tenant MCPs on one Redis don't collide but replicas DO share.
          const oauthStore = await createOAuthStore({
            redisUrl: process.env.REDIS_URL,
            keyPrefix: `${process.env.REDIS_KEY_PREFIX || 'gitlab-mcp'}:${issuerUrl.host}`,
          });
          this.oauthProvider = new GitLabOAuthProvider(oauthOptions, oauthStore);
          if (process.env.REDIS_URL) {
            console.error(`[MCP] OAuth state store: Redis (${issuerUrl.host})`);
          }

          // Standard AS endpoints: /authorize, /token, /register, /revoke, and the
          // .well-known metadata documents. Must be mounted at the app root.
          app.use(
            mcpAuthRouter({
              provider: this.oauthProvider,
              issuerUrl,
              scopesSupported: oauthOptions.scopes.split(/[\s,]+/).filter(Boolean),
              resourceName: 'GitLab MCP Server',
            })
          );

          // Fixed GitLab callback (the only redirect URI registered in GitLab).
          app.get(oauthOptions.callbackPath, (req, res) => this.oauthProvider!.handleGitLabCallback(req, res));

          // Gate the MCP endpoints; 401s carry WWW-Authenticate → resource metadata.
          mcpGuards.push(
            requireBearerAuth({
              verifier: this.oauthProvider,
              resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(issuerUrl),
            })
          );
          console.error(`[MCP] OAuth enabled — issuer ${oauthOptions.serverUrl}, GitLab callback ${oauthOptions.callbackPath}`);
        }

        // Streamable HTTP endpoint at root (primary transport)
        app.all('/', ...mcpGuards, (req, res) => this.handleStreamableHTTP(req, res));

        // Alternative /mcp endpoint for container compatibility
        app.all('/mcp', ...mcpGuards, (req, res) => this.handleStreamableHTTP(req, res));

        // DELETE (explicit session termination, per MCP spec) is matched by the
        // app.all('/') and app.all('/mcp') routes below and handled by the
        // StreamableHTTP transport — behind the same bearer guard as POST/GET.

        // Health check endpoint
        app.get('/health', (req, res) => {
          res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            sessions: this.httpSessions.size,
            version: SERVER_VERSION,
            protocol: LATEST_PROTOCOL_VERSION
          });
        });

        app.listen(port, () => {
          console.error('='.repeat(60));
          console.error('GitLab MCP Server - HTTP Mode');
          console.error('='.repeat(60));
          console.error(`Server: http://localhost:${port}`);
          console.error(`Streamable HTTP: http://localhost:${port}/ (recommended)`);
          console.error(`Alternative: http://localhost:${port}/mcp`);
          console.error(`Health check: http://localhost:${port}/health`);
          console.error(`Protocol: MCP ${LATEST_PROTOCOL_VERSION}`);
          console.error('');
          console.error('Configuration:');
          const httpConfig = loadConfig();
          const httpTokenLabel = httpConfig.token
            ? 'GITLAB_TOKEN (full access)'
            : httpConfig.readToken
              ? 'GITLAB_READ_TOKEN (read-only)'
              : 'none — per-call user credentials required for every operation';
          console.error(`  GitLab URL: ${httpConfig.gitlabUrl}`);
          console.error(`  Fallback token: ${httpTokenLabel}`);
          console.error(`  Session cleanup: 10min timeout, checked every 2min`);
          console.error('');
          console.error('For LibreChat: Use streamable-http transport in librechat.yml');
          console.error('='.repeat(60));

          // Start session cleanup
          this.startSessionCleanup();
        });
      } else {
        // Default to stdio transport
        const config = loadConfig();
        console.error('='.repeat(60));
        console.error('GitLab MCP Server - stdio Mode');
        console.error('='.repeat(60));
        console.error('Transport: stdio (for Claude Desktop, Claude Code, VS Code)');
        console.error(`Protocol: MCP ${LATEST_PROTOCOL_VERSION}`);
        console.error('');
        console.error('Configuration:');
        console.error(`  GitLab URL: ${config.gitlabUrl}`);
        console.error(`  Token: ${config.token ? 'GITLAB_TOKEN (full access)' : config.readToken ? 'GITLAB_READ_TOKEN (read-only)' : '✗ not set (per-call user credentials required)'}`);
        console.error('');
        console.error('Tip: Set GITLAB_MCP_PORT to enable HTTP mode for LibreChat');
        console.error('='.repeat(60));

        // Create server for stdio mode
        this.server = this.createServer();
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
      }

      // Setup process signal handlers
      this.setupProcessHandlers();
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Run in CLI mode only if this file is the program entry-point.
// Use realpathSync on both paths so symlink-based invocation (e.g. via npx
// or .bin/ wrappers) resolves to the same real path as import.meta.url.
const isMain = (() => {
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = realpathSync(process.argv[1]);
    return !!(process.argv[1] && thisFile === entryFile);
  } catch {
    return false;
  }
})();

if (isMain) {
  const cli = new GitLabMCPServer();
  cli.run().catch((error) => {
    console.error('Server failed:', error);
    process.exit(1);
  });
}