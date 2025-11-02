#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as http from 'http';
import { randomUUID } from 'node:crypto';
import { URL, fileURLToPath } from 'url';
import express from 'express';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { tools } from './tools.js';

class GitLabMCPServer {
  private server: Server;
  private gitlabClient!: GitLabGraphQLClient;
  private sseTransports: Map<string, SSEServerTransport> = new Map();
  private httpTransports: Map<string, {
    transport: StreamableHTTPServerTransport;
    userConfig?: { accessToken: string; gitlabUrl?: string };
    lastActivity: number;
  }> = new Map();
  private sessionCleanupInterval?: NodeJS.Timeout;

  constructor() {
    this.server = new Server(
      {
        name: 'gitlab-mcp-server',
        version: '1.1.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupPromptHandlers();
    this.setupErrorHandling();

    // Initialize GitLab client using environment configuration
    const config = loadConfig();
    this.gitlabClient = new GitLabGraphQLClient(config);
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: zodToJsonSchema(tool.inputSchema, { target: 'jsonSchema7' }),
          ...(tool.annotations && { annotations: tool.annotations }),
        })),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;

      const tool = tools.find(t => t.name === name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
      }

      try {
        const validatedInput = tool.inputSchema.parse(args || {});

        // Extract user credentials: prioritize args, fallback to session-specific config
        let userConfig = validatedInput.userCredentials;

        // If no credentials in args, try to get from session context
        if (!userConfig && extra?._meta?.sessionId) {
          const sessionData = this.httpTransports.get(extra._meta.sessionId as string);
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

  private setupPromptHandlers(): void {
    // Define helpful prompts for common GitLab workflows
    const prompts = [
      {
        name: 'explore-project',
        description: 'Explore a GitLab project structure and recent activity',
        arguments: [
          {
            name: 'projectPath',
            description: 'Full path of the project (e.g., "group/project-name")',
            required: true,
          },
        ],
      },
      {
        name: 'find-my-work',
        description: 'Find issues and merge requests assigned to you',
        arguments: [],
      },
      {
        name: 'review-merge-request',
        description: 'Review a specific merge request with code changes',
        arguments: [
          {
            name: 'projectPath',
            description: 'Full path of the project (e.g., "group/project-name")',
            required: true,
          },
          {
            name: 'mrIid',
            description: 'Merge request IID number',
            required: true,
          },
        ],
      },
    ];

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return { prompts };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'explore-project') {
        const projectPath = args?.projectPath as string;
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please explore the GitLab project "${projectPath}". Show me:
1. Project overview and description
2. Recent issues (last 10)
3. Recent merge requests (last 10)
4. Repository structure (browse the root directory)

Provide direct links to all resources you find.`,
              },
            },
          ],
        };
      }

      if (name === 'find-my-work') {
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please find all issues and merge requests assigned to me. Search for:
1. Open issues assigned to me
2. Open merge requests where I'm assigned or a reviewer
3. Recently closed items from the last week

Provide direct links to each item and summarize the current state.`,
              },
            },
          ],
        };
      }

      if (name === 'review-merge-request') {
        const projectPath = args?.projectPath as string;
        const mrIid = args?.mrIid as string;
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please review merge request !${mrIid} in project "${projectPath}". Show me:
1. MR title, description, and status
2. Source and target branches
3. Changed files (browse the repository at both refs if needed)
4. Related issues
5. Review comments and approvals

Provide the direct link to the MR and suggest any concerns or next steps.`,
              },
            },
          ],
        };
      }

      throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
    });
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      if (this.sessionCleanupInterval) {
        clearInterval(this.sessionCleanupInterval);
      }
      await this.server.close();
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

      for (const [sessionId, data] of this.httpTransports.entries()) {
        if (now - data.lastActivity > SESSION_TIMEOUT) {
          expiredSessions.push(sessionId);
        }
      }

      for (const sessionId of expiredSessions) {
        const data = this.httpTransports.get(sessionId);
        if (data) {
          console.error(`[MCP] Session ${sessionId} expired due to inactivity`);
          data.transport.close().catch(() => {});
          this.httpTransports.delete(sessionId);
        }
      }

      if (expiredSessions.length > 0) {
        console.error(`[MCP] Cleaned up ${expiredSessions.length} expired session(s). Active sessions: ${this.httpTransports.size}`);
      }
    }, CLEANUP_INTERVAL);
  }

  /**
   * Extract and validate user credentials from request headers
   */
  private extractUserCredentials(req: express.Request): { accessToken: string; gitlabUrl?: string } | undefined {
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
      // Debug logging to understand what's happening
      const hasBody = req.body && Object.keys(req.body).length > 0;
      const bodyPreview = hasBody ? JSON.stringify(req.body).substring(0, 100) : 'empty';

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

      console.error(`[MCP] Request: ${req.method} session=${sessionIdHeader || 'none'} body=${bodyPreview}`);

      if (sessionIdHeader && this.httpTransports.has(sessionIdHeader)) {
        // Existing session: reuse transport and update credentials
        const sessionData = this.httpTransports.get(sessionIdHeader)!;
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
        if (this.httpTransports.size > 10) {
          const now = Date.now();
          const oldSessions: string[] = [];

          // Find sessions older than 5 minutes
          for (const [sessionId, data] of this.httpTransports.entries()) {
            if (now - data.lastActivity > 5 * 60 * 1000) {
              oldSessions.push(sessionId);
            }
          }

          // Close and remove old sessions
          for (const sessionId of oldSessions) {
            const data = this.httpTransports.get(sessionId);
            if (data) {
              console.error(`[MCP] Force-closing old session ${sessionId}`);
              data.transport.close().catch(() => {});
              this.httpTransports.delete(sessionId);
            }
          }

          if (oldSessions.length > 0) {
            console.error(`[MCP] Emergency cleanup: removed ${oldSessions.length} old sessions (total now: ${this.httpTransports.size})`);
          }
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId: string) => {
            const userConfig = this.extractUserCredentials(req);
            this.httpTransports.set(sessionId, {
              transport,
              userConfig,
              lastActivity: Date.now()
            });
            console.error(`[MCP] Session ${sessionId} initialized with ${userConfig ? 'user' : 'shared'} credentials (total sessions: ${this.httpTransports.size})`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            console.error(`[MCP] Session ${transport.sessionId} closed (remaining sessions: ${this.httpTransports.size - 1})`);
            this.httpTransports.delete(transport.sessionId);
          }
        };

        // Handle errors on the transport
        transport.onerror = (error: Error) => {
          console.error(`[MCP] Transport error for session ${transport.sessionId}:`, error.message);
        };

        await this.server.connect(transport);
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
      
      // Try to introspect schema on startup if we have a shared token
      if (config.sharedAccessToken) {
        try {
          await this.gitlabClient.introspectSchema();
          console.error('GitLab GraphQL schema introspected successfully using shared token');
        } catch (error) {
          console.error('Warning: Failed to introspect schema with shared token:', error);
          console.error('Schema will be introspected when user credentials are provided');
        }
      } else {
        console.error('No shared access token provided. Schema will be introspected when user credentials are provided.');
      }
      
      // Determine transport based on environment
      // Note: For Smithery TypeScript runtime, run in stdio; their wrapper provides HTTP.
      const port = process.env.GITLAB_MCP_PORT ? parseInt(process.env.GITLAB_MCP_PORT) : null;
      const useHttp = process.env.MCP_TRANSPORT === 'http';
      
      if (useHttp && port) {
        // Streamable HTTP transport for LibreChat and modern MCP clients
        const app = express();

        // Disable X-Powered-By header
        app.disable('x-powered-by');

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
          res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');

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

        // SSE transport endpoints for LibreChat compatibility
        app.get('/sse', async (req, res) => {
          try {
            // Emergency cleanup if we have too many sessions
            if (this.sseTransports.size > 10) {
              console.error(`[MCP] WARNING: ${this.sseTransports.size} SSE sessions accumulated! Forcing cleanup...`);

              // Close all sessions - LibreChat will reconnect properly
              const oldSessions = Array.from(this.sseTransports.keys());
              for (const sessionId of oldSessions) {
                const transport = this.sseTransports.get(sessionId);
                if (transport) {
                  try {
                    transport.close();
                  } catch (e) {
                    // Ignore errors during emergency cleanup
                  }
                  this.sseTransports.delete(sessionId);
                }
              }
              console.error(`[MCP] Emergency cleanup complete. Cleared ${oldSessions.length} sessions.`);
            }

            console.error('[MCP] New SSE connection request');

            const sessionId = (req.query.sessionId as string) || randomUUID();

            if (this.sseTransports.has(sessionId)) {
              console.error(`[MCP] SSE session ${sessionId} already exists, rejecting`);
              res.status(409).send('Session already exists');
              return;
            }

            // Set aggressive timeouts to keep connection alive
            req.socket.setTimeout(0); // Disable timeout
            req.socket.setKeepAlive(true, 30000); // Send keepalive every 30s
            res.socket?.setTimeout(0);
            res.socket?.setKeepAlive(true, 30000);

            const transport = new SSEServerTransport('/message', res);
            this.sseTransports.set(transport.sessionId, transport);

            console.error(`[MCP] SSE session ${transport.sessionId} created (total SSE sessions: ${this.sseTransports.size})`);

            transport.onclose = () => {
              console.error(`[MCP] SSE session ${transport.sessionId} closed (reason: connection ended)`);
              this.sseTransports.delete(transport.sessionId);
            };

            // Handle client disconnect
            req.on('close', () => {
              console.error(`[MCP] Client disconnected for session ${transport.sessionId}`);
              this.sseTransports.delete(transport.sessionId);
            });

            await this.server.connect(transport);

            // Keep the SSE connection alive with periodic comments
            // SSE connections need activity to prevent timeouts
            const keepaliveInterval = setInterval(() => {
              if (!res.socket || res.socket.destroyed) {
                clearInterval(keepaliveInterval);
                return;
              }
              // Send SSE comment to keep connection alive (won't be processed as data)
              try {
                res.write(': keepalive\n\n');
              } catch (e) {
                clearInterval(keepaliveInterval);
              }
            }, 15000); // Every 15 seconds

            // Clean up interval when connection closes
            res.on('close', () => {
              clearInterval(keepaliveInterval);
            });

            // Don't end the response - SSE keeps it open
            // The SDK's SSEServerTransport will manage the connection
          } catch (error) {
            console.error('[MCP] Error in SSE endpoint:', error);
            if (!res.headersSent) {
              res.status(500).send('Internal server error');
            }
          }
        });

        app.post('/message', async (req, res) => {
          try {
            const url = new URL(req.url || '', `http://localhost:${port}`);
            const sessionId = url.searchParams.get('sessionId');

            if (!sessionId) {
              res.status(400).send('Missing session ID');
              return;
            }

            const transport = this.sseTransports.get(sessionId);
            if (!transport) {
              res.status(404).send('Session not found');
              return;
            }

            // The SDK's handlePostMessage needs the full request object, not just body
            await transport.handlePostMessage(req as any, res as any);
          } catch (error) {
            console.error('[MCP] Error in message endpoint:', error);
            if (!res.headersSent) {
              res.status(500).send('Internal server error');
            }
          }
        });

        // Streamable HTTP endpoint at root (for other clients)
        app.all('/', (req, res) => this.handleStreamableHTTP(req, res));

        // Alternative /mcp endpoint for container compatibility
        app.all('/mcp', (req, res) => this.handleStreamableHTTP(req, res));

        // DELETE support for explicit session termination (per MCP spec)
        app.delete('/', async (req, res) => {
          const sessionIdHeader = (req.headers['mcp-session-id'] as string) || '';
          if (sessionIdHeader && this.httpTransports.has(sessionIdHeader)) {
            const sessionData = this.httpTransports.get(sessionIdHeader)!;
            await sessionData.transport.close();
            this.httpTransports.delete(sessionIdHeader);
            console.error(`[MCP] Session ${sessionIdHeader} terminated by client`);
            res.sendStatus(200);
          } else {
            res.status(404).json({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            });
          }
        });

        app.delete('/mcp', async (req, res) => {
          const sessionIdHeader = (req.headers['mcp-session-id'] as string) || '';
          if (sessionIdHeader && this.httpTransports.has(sessionIdHeader)) {
            const sessionData = this.httpTransports.get(sessionIdHeader)!;
            await sessionData.transport.close();
            this.httpTransports.delete(sessionIdHeader);
            console.error(`[MCP] Session ${sessionIdHeader} terminated by client`);
            res.sendStatus(200);
          } else {
            res.status(404).json({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found' },
              id: null,
            });
          }
        });

        // Container-runtime compatibility: serve config schema
        app.get('/.well-known/mcp-config', (req, res) => {
          res.set('Content-Type', 'application/schema+json; charset=utf-8');
          const baseSchema = zodToJsonSchema(configSchema, { target: 'jsonSchema7' });
          const configJsonSchema = {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $id: `${req.protocol}://${req.get('host')}/.well-known/mcp-config`,
            title: 'MCP Session Configuration',
            description: 'Schema for the /mcp endpoint configuration',
            'x-mcp-version': '1.0',
            'x-query-style': 'dot+bracket',
            ...baseSchema,
          } as any;
          res.json(configJsonSchema);
        });

        // Health check endpoint
        app.get('/health', (req, res) => {
          res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            transports: {
              sse: this.sseTransports.size,
              streamableHttp: this.httpTransports.size
            },
            protocol: '2025-03-26'
          });
        });

        app.listen(port, () => {
          console.error(`GitLab MCP Server running on HTTP port ${port}`);
          console.error(`SSE transport: http://localhost:${port}/sse (for LibreChat)`);
          console.error(`Streamable HTTP: http://localhost:${port}/ (for other clients)`);
          console.error(`Health check: http://localhost:${port}/health`);
          console.error(`Supported transports: SSE, Streamable HTTP`);

          // Start session cleanup
          this.startSessionCleanup();
          console.error(`Session cleanup enabled (10min timeout, checked every 2min)`);
        });
      } else {
        // Default to stdio transport
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('GitLab MCP Server running on stdio');
      }
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Smithery TypeScript runtime expects a default export that returns an MCP Server instance.
// This factory prepares the server with all handlers but does not bind transports.
export default function createMcpServer(_args: { sessionId: string; config: unknown }): Server {
  const instance = new GitLabMCPServer();
  // Return the underlying MCP Server; the host (e.g., Smithery) will call connect(transport)
  // and manage the Streamable HTTP session lifecycle.
  // @ts-ignore accessing private for integration factory
  return (instance as any)["server"] as Server;
}

// Optional: expose a (currently empty) config schema for /.well-known/mcp-config
export const configSchema = z.object({});

// Run in CLI mode only if this file is the program entry-point
const isMain = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return process.argv[1] && thisFile === process.argv[1];
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