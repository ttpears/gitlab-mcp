import { randomBytes, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

/**
 * GitLab OAuth broker.
 *
 * The MCP server acts as its own OAuth 2.1 Authorization Server (mounted via the
 * SDK's `mcpAuthRouter`) that brokers GitLab's OAuth behind a single registered
 * GitLab application + one fixed callback. MCP clients (Claude.ai, Claude Code,
 * etc.) register dynamically (RFC 7591), run the standard authorization-code +
 * PKCE flow against THIS server, and we in turn run a second authorization-code +
 * PKCE flow against GitLab. Each user logs in with their own GitLab identity; we
 * mint our own opaque bearer tokens and keep the user's GitLab token server-side,
 * never passing the client's MCP token through to GitLab (per the MCP security
 * best-practices: no token passthrough).
 *
 * Storage is in-memory and therefore single-instance. A horizontally-scaled
 * deployment would need a shared store (Redis, signed stateless tokens, etc.).
 */

const AUTH_FLOW_TTL_MS = 10 * 60 * 1000; // pending-auth and one-time codes live 10 min
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // fallback when GitLab omits expires_in
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // cap idle refresh tokens at 30 days
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface GitLabOAuthOptions {
  /** GitLab base URL without the /api suffix, e.g. https://gitlab.com */
  gitlabBaseUrl: string;
  /** Public HTTPS URL of this MCP server (the OAuth issuer / resource identifier) */
  serverUrl: string;
  /** GitLab application id (client_id of the one registered GitLab app) */
  clientId: string;
  /** GitLab application secret — required for confidential apps, omit for public */
  clientSecret?: string;
  /** GitLab scopes to request, space-separated (e.g. "api read_user") */
  scopes: string;
  /** Path of the fixed GitLab callback, e.g. /gitlab/callback */
  callbackPath: string;
  /** Request timeout for GitLab token calls, ms */
  timeoutMs: number;
  /**
   * Optional access allow-list: GitLab group full-paths whose members may use
   * this connector (a member of a group is allowed for that group and all its
   * subgroups). Empty = open to any authenticated GitLab user.
   */
  allowedGroups: string[];
}

interface PendingAuth {
  clientId: string;
  clientRedirectUri: string;
  clientState?: string;
  clientCodeChallenge: string;
  scopes: string[];
  resource?: string;
  gitlabCodeVerifier: string;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  clientCodeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  gitlabAccessToken: string;
  gitlabRefreshToken?: string;
  gitlabExpiresAt: number;
  expiresAt: number;
}

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  gitlabAccessToken: string;
  expiresAt: number; // seconds since epoch (AuthInfo contract)
}

interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  gitlabRefreshToken: string;
  /** The MCP access token minted alongside this refresh token, so rotation can revoke it. */
  accessToken: string;
  expiresAt: number; // ms since epoch; purged after this
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
  return base64url(randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** In-memory Dynamic Client Registration store. */
class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.clients.set(client.client_id, client);
    return client;
  }
}

export class GitLabOAuthProvider implements OAuthServerProvider {
  private readonly opts: GitLabOAuthOptions;
  private readonly clients = new InMemoryClientsStore();
  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(opts: GitLabOAuthOptions) {
    this.opts = opts;
    this.cleanupTimer = setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL_MS);
    // Don't keep the process alive solely for cleanup.
    this.cleanupTimer.unref?.();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clients;
  }

  /** Full callback URL registered with GitLab. */
  private get callbackUrl(): string {
    return `${this.opts.serverUrl.replace(/\/$/, '')}${this.opts.callbackPath}`;
  }

  /**
   * Step 1: client hits our /authorize. We stash the client's PKCE/redirect, then
   * redirect the browser to GitLab with our OWN server-side PKCE and fixed callback.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const brokerState = randomToken();
    const gitlabCodeVerifier = base64url(randomBytes(64));

    // The minted token can only ever do what the configured GitLab app scopes
    // allow, so record those — not the client's requested scopes — to keep
    // AuthInfo.scopes honest about the token's real capability.
    const grantedScopes = this.opts.scopes.split(/[\s,]+/).filter(Boolean);

    this.pending.set(brokerState, {
      clientId: client.client_id,
      clientRedirectUri: params.redirectUri,
      clientState: params.state,
      clientCodeChallenge: params.codeChallenge,
      scopes: grantedScopes,
      resource: params.resource?.toString(),
      gitlabCodeVerifier,
      expiresAt: Date.now() + AUTH_FLOW_TTL_MS,
    });

    const authUrl = new URL(`${this.opts.gitlabBaseUrl.replace(/\/$/, '')}/oauth/authorize`);
    authUrl.searchParams.set('client_id', this.opts.clientId);
    authUrl.searchParams.set('redirect_uri', this.callbackUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', brokerState);
    authUrl.searchParams.set('scope', this.opts.scopes.split(/[\s,]+/).filter(Boolean).join(' '));
    authUrl.searchParams.set('code_challenge', pkceChallenge(gitlabCodeVerifier));
    authUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(authUrl.toString());
  }

  /**
   * Step 2: GitLab redirects the browser back to our fixed callback. We exchange
   * the GitLab code for GitLab tokens, mint a one-time MCP authorization code, and
   * redirect the browser to the original MCP client's redirect URI.
   *
   * Mount as: app.get(callbackPath, (req, res) => provider.handleGitLabCallback(req, res))
   */
  async handleGitLabCallback(req: Request, res: Response): Promise<void> {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const brokerState = typeof req.query.state === 'string' ? req.query.state : undefined;
    const gitlabError = typeof req.query.error === 'string' ? req.query.error : undefined;

    // Always respond as text/plain: req.query values are attacker-controllable and
    // res.send(string) would otherwise default to text/html (reflected-XSS vector).
    if (gitlabError) {
      res.status(400).type('text/plain').send(`GitLab authorization failed: ${gitlabError}`);
      return;
    }
    if (!code || !brokerState) {
      res.status(400).type('text/plain').send('Missing code or state from GitLab callback');
      return;
    }

    const pending = this.pending.get(brokerState);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(brokerState);
      res.status(400).type('text/plain').send('Authorization request expired or unknown. Please restart sign-in.');
      return;
    }
    this.pending.delete(brokerState);

    let tokens;
    try {
      tokens = await this.gitlabTokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl,
        code_verifier: pending.gitlabCodeVerifier,
      });
    } catch (err) {
      res.status(502).type('text/plain').send(`Failed to exchange code with GitLab: ${(err as Error).message}`);
      return;
    }

    // Access allow-list: reject users who aren't a member of any configured group
    // before we mint anything. Return the OAuth error to the client's redirect URI
    // (access_denied) so the MCP client surfaces a proper "not authorized" message.
    if (this.opts.allowedGroups.length > 0) {
      let allowed: boolean;
      try {
        allowed = await this.userIsInAllowedGroup(tokens.access_token);
      } catch (err) {
        res.status(502).type('text/plain').send(`Failed to verify group membership: ${(err as Error).message}`);
        return;
      }
      if (!allowed) {
        const denied = new URL(pending.clientRedirectUri);
        denied.searchParams.set('error', 'access_denied');
        denied.searchParams.set(
          'error_description',
          'Your GitLab account is not a member of a group permitted to use this connector.'
        );
        if (pending.clientState) denied.searchParams.set('state', pending.clientState);
        res.redirect(denied.toString());
        return;
      }
    }

    const mcpCode = randomToken();
    this.codes.set(mcpCode, {
      clientId: pending.clientId,
      clientCodeChallenge: pending.clientCodeChallenge,
      redirectUri: pending.clientRedirectUri,
      scopes: pending.scopes,
      resource: pending.resource,
      gitlabAccessToken: tokens.access_token,
      gitlabRefreshToken: tokens.refresh_token,
      gitlabExpiresAt: Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
      expiresAt: Date.now() + AUTH_FLOW_TTL_MS,
    });

    const redirect = new URL(pending.clientRedirectUri);
    redirect.searchParams.set('code', mcpCode);
    if (pending.clientState) redirect.searchParams.set('state', pending.clientState);
    res.redirect(redirect.toString());
  }

  /** SDK calls this to validate the MCP client's PKCE verifier at token exchange. */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError('Authorization code is invalid or expired');
    }
    return record.clientCodeChallenge;
  }

  /** Step 3: client exchanges the one-time MCP code for an MCP bearer token. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError('Authorization code is invalid or expired');
    }
    // One-time use.
    this.codes.delete(authorizationCode);
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    return this.mintTokens(record);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(refreshToken);
    if (!record) {
      throw new InvalidGrantError('Refresh token is invalid');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }

    let tokens;
    try {
      tokens = await this.gitlabTokenRequest({
        grant_type: 'refresh_token',
        refresh_token: record.gitlabRefreshToken,
      });
    } catch (err) {
      throw new ServerError(`Failed to refresh GitLab token: ${(err as Error).message}`);
    }

    // Rotate: drop the old refresh token and revoke its paired access token so a
    // stolen access token can't outlive a refresh.
    this.refreshTokens.delete(refreshToken);
    this.accessTokens.delete(record.accessToken);
    return this.mintTokens({
      clientId: record.clientId,
      clientCodeChallenge: '',
      redirectUri: '',
      scopes: record.scopes,
      resource: record.resource,
      gitlabAccessToken: tokens.access_token,
      gitlabRefreshToken: tokens.refresh_token ?? record.gitlabRefreshToken,
      gitlabExpiresAt: Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
      expiresAt: 0,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(token);
    if (!record) {
      throw new InvalidTokenError('Unknown or revoked access token');
    }
    if (record.expiresAt * 1000 < Date.now()) {
      this.accessTokens.delete(token);
      throw new InvalidTokenError('Access token has expired');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : new URL(this.opts.serverUrl),
      // The per-user GitLab token rides in `extra` so the tool layer can act as the
      // authenticated user without the GitLab token ever leaving the server.
      extra: { gitlabToken: record.gitlabAccessToken },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.accessTokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  // --- internals -----------------------------------------------------------

  private mintTokens(record: IssuedCode): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const ttlMs = Math.max(0, record.gitlabExpiresAt - Date.now()) || DEFAULT_TOKEN_TTL_MS;
    const expiresAtSec = Math.floor((Date.now() + ttlMs) / 1000);

    this.accessTokens.set(accessToken, {
      clientId: record.clientId,
      scopes: record.scopes,
      resource: record.resource,
      gitlabAccessToken: record.gitlabAccessToken,
      expiresAt: expiresAtSec,
    });

    if (record.gitlabRefreshToken) {
      this.refreshTokens.set(refreshToken, {
        clientId: record.clientId,
        scopes: record.scopes,
        resource: record.resource,
        gitlabRefreshToken: record.gitlabRefreshToken,
        accessToken,
        expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      });
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ttlMs / 1000),
      scope: record.scopes.join(' '),
      ...(record.gitlabRefreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  private async gitlabTokenRequest(params: Record<string, string>): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }> {
    const body = new URLSearchParams({
      ...params,
      client_id: this.opts.clientId,
      ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}),
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const resp = await fetch(`${this.opts.gitlabBaseUrl.replace(/\/$/, '')}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!resp.ok) {
        let detail = resp.statusText;
        try {
          const j: any = await resp.json();
          detail = j.error_description || j.error || detail;
        } catch {
          /* non-JSON */
        }
        throw new Error(`GitLab token endpoint returned ${resp.status}: ${detail}`);
      }
      return (await resp.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Is the GitLab user (identified by their freshly-issued token) a member of any
   * configured allowed group, or a subgroup thereof? Pages through the user's
   * member groups and matches each allowed full-path as an exact or ancestor path
   * (so allowing "team" admits members of "team/backend"). Case-insensitive.
   */
  private async userIsInAllowedGroup(gitlabAccessToken: string): Promise<boolean> {
    const allowed = this.opts.allowedGroups.map((g) => g.toLowerCase().replace(/^\/+|\/+$/g, ''));
    if (allowed.length === 0) return true;
    // Up to 10 pages × 100 = 1000 groups; min_access_level=10 (Guest) = any membership.
    for (let page = 1; page <= 10; page++) {
      const resp = await this.gitlabApiGet(
        `/groups?min_access_level=10&per_page=100&page=${page}`,
        gitlabAccessToken
      );
      if (!resp.ok) {
        throw new Error(`GitLab group membership lookup returned ${resp.status}`);
      }
      const groups = (await resp.json()) as Array<{ full_path?: string }>;
      for (const g of groups) {
        const fp = (g.full_path || '').toLowerCase();
        if (!fp) continue;
        if (allowed.some((a) => fp === a || fp.startsWith(a + '/'))) return true;
      }
      if (groups.length < 100) break; // last page reached
    }
    return false;
  }

  /** Authenticated GET against the GitLab REST API as the user, with timeout. */
  private async gitlabApiGet(path: string, gitlabAccessToken: string) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await fetch(`${this.opts.gitlabBaseUrl.replace(/\/$/, '')}/api/v4${path}`, {
        headers: { Authorization: `Bearer ${gitlabAccessToken}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.accessTokens) if (v.expiresAt * 1000 < now) this.accessTokens.delete(k);
    for (const [k, v] of this.refreshTokens) if (v.expiresAt < now) this.refreshTokens.delete(k);
  }
}

/**
 * Validate and assemble GitLab OAuth options from config/env. Throws a clear
 * startup error if a required value is missing so misconfiguration fails fast.
 */
export function buildOAuthOptions(input: {
  gitlabUrl: string;
  serverUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  callbackPath?: string;
  allowedGroups?: string;
  timeoutMs: number;
}): GitLabOAuthOptions {
  const missing: string[] = [];
  if (!input.serverUrl) missing.push('MCP_SERVER_URL');
  if (!input.clientId) missing.push('GITLAB_OAUTH_CLIENT_ID');
  if (missing.length) {
    throw new Error(
      `GITLAB_MCP_OAUTH is enabled but required settings are missing: ${missing.join(', ')}.`
    );
  }
  let serverUrl: URL;
  try {
    serverUrl = new URL(input.serverUrl!);
  } catch {
    throw new Error(`MCP_SERVER_URL is not a valid URL: ${input.serverUrl}`);
  }
  if (serverUrl.protocol !== 'https:' && serverUrl.hostname !== 'localhost' && serverUrl.hostname !== '127.0.0.1') {
    throw new Error('MCP_SERVER_URL must use https (except for localhost during development).');
  }

  return {
    gitlabBaseUrl: input.gitlabUrl,
    serverUrl: input.serverUrl!,
    clientId: input.clientId!,
    clientSecret: input.clientSecret || undefined,
    scopes: input.scopes && input.scopes.trim() ? input.scopes.trim() : 'api',
    callbackPath: input.callbackPath && input.callbackPath.startsWith('/') ? input.callbackPath : '/gitlab/callback',
    allowedGroups: (input.allowedGroups || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    timeoutMs: input.timeoutMs,
  };
}
