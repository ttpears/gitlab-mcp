import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fetchBuffered } from './http.js';
import { InMemoryKvStore, type KvStore } from './oauth-store.js';
export { InMemoryKvStore, RedisKvStore, EncryptedKvStore, createOAuthStore, type KvStore } from './oauth-store.js';
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
  InvalidTargetError,
  InvalidTokenError,
  InvalidClientMetadataError,
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
 * Broker state (clients, pending flows, codes, tokens) lives behind a {@link KvStore}.
 * With REDIS_URL set it is Redis-backed, so the connector survives redeploys and
 * can run more than one replica; otherwise it falls back to in-process memory
 * (fine for stdio/single-instance).
 */

const AUTH_FLOW_TTL_MS = 10 * 60 * 1000; // pending-auth and one-time codes live 10 min
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // fallback when GitLab omits expires_in
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // absolute token-family lifetime
const CLIENT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // DCR client registrations

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
  clientState?: string;
}

interface AccessTokenRecord {
  familyId: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  gitlabAccessToken: string;
  expiresAt: number; // seconds since epoch (AuthInfo contract)
}

interface RefreshTokenRecord {
  familyId: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  gitlabRefreshToken: string;
  /** The MCP access token minted alongside this refresh token, so rotation can revoke it. */
  accessTokenHash: string;
}

interface ConsentRecord {
  grant: IssuedCode;
  csrfHash: string;
  browserHash: string;
}
interface TokenFamily { clientId: string }
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenKey = (kind: 'at' | 'rt' | 'code', token: string) => `${kind}:${tokenHash(token)}`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
  return base64url(randomBytes(32));
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Dynamic Client Registration store backed by the KvStore. */
class KvClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: KvStore) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.store.get<OAuthClientInformationFull>(`client:${clientId}`);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (Buffer.byteLength(JSON.stringify(client)) > 16384) throw new InvalidClientMetadataError('Client registration metadata exceeds the 16 KiB limit');
    await this.store.set(`client:${client.client_id}`, client, CLIENT_TTL_MS);
    return client;
  }
}

// --- provider ----------------------------------------------------------------

export class GitLabOAuthProvider implements OAuthServerProvider {
  private readonly opts: GitLabOAuthOptions;
  private readonly store: KvStore;
  private readonly clients: KvClientsStore;

  constructor(opts: GitLabOAuthOptions, store: KvStore = new InMemoryKvStore()) {
    this.opts = opts;
    this.store = store;
    this.clients = new KvClientsStore(store);
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
    const resource = params.resource ?? new URL(this.opts.serverUrl);
    const normalizeResource = (url: URL) => {
      const value = new URL(url);
      value.hash = '';
      return value.toString().replace(/\/$/, '');
    };
    if (normalizeResource(resource) !== normalizeResource(new URL(this.opts.serverUrl))) {
      throw new InvalidTargetError('Requested resource does not match this MCP server');
    }
    const brokerState = randomToken();
    const gitlabCodeVerifier = base64url(randomBytes(64));

    // The minted token can only ever do what the configured GitLab app scopes
    // allow, so record those — not the client's requested scopes — to keep
    // AuthInfo.scopes honest about the token's real capability.
    const grantedScopes = this.opts.scopes.split(/[\s,]+/).filter(Boolean);

    await this.store.set<PendingAuth>(
      `pending:${brokerState}`,
      {
        clientId: client.client_id,
        clientRedirectUri: params.redirectUri,
        clientState: params.state,
        clientCodeChallenge: params.codeChallenge,
        scopes: grantedScopes,
        resource: new URL(this.opts.serverUrl).toString(),
        gitlabCodeVerifier,
      },
      AUTH_FLOW_TTL_MS
    );

    const authUrl = new URL(`${this.opts.gitlabBaseUrl.replace(/\/$/, '')}/oauth/authorize`);
    authUrl.searchParams.set('client_id', this.opts.clientId);
    authUrl.searchParams.set('redirect_uri', this.callbackUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', brokerState);
    authUrl.searchParams.set('scope', grantedScopes.join(' '));
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

    const pending = await this.store.take<PendingAuth>(`pending:${brokerState}`);
    if (!pending) {
      res.status(400).type('text/plain').send('Authorization request expired or unknown. Please restart sign-in.');
      return;
    }

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

    const consentId = randomToken();
    const csrf = randomToken();
    const browser = randomToken();
    await this.store.set<ConsentRecord>(`consent:${consentId}`, {
      csrfHash: tokenHash(csrf), browserHash: tokenHash(browser),
      grant: {
        clientId: pending.clientId, clientCodeChallenge: pending.clientCodeChallenge,
        redirectUri: pending.clientRedirectUri, clientState: pending.clientState,
        scopes: pending.scopes, resource: pending.resource,
        gitlabAccessToken: tokens.access_token, gitlabRefreshToken: tokens.refresh_token,
        gitlabExpiresAt: Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
      },
    }, AUTH_FLOW_TTL_MS);
    const secure = new URL(this.opts.serverUrl).protocol === 'https:';
    res.cookie(secure ? '__Host-mcp-consent' : 'mcp-consent', browser, {
      httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: AUTH_FLOW_TTL_MS,
    });
    const registered = await this.clients.getClient(pending.clientId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize GitLab access</title>
<h1>Allow this application to access GitLab?</h1>
<p>Application: <strong>${escapeHtml(registered?.client_name || pending.clientId)}</strong></p>
<p>Client ID: ${escapeHtml(pending.clientId)}</p>
<p>Authorization will be sent to: <strong>${escapeHtml(pending.clientRedirectUri)}</strong></p>
<p>GitLab permissions: ${escapeHtml(pending.scopes.join(' '))}</p>
<p>Approve only if you recognize this application and requested this connection.</p>
<form method="post" action="/oauth/consent"><input type="hidden" name="consent" value="${consentId}">
<input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="allow">Allow access</button>
<button name="decision" value="deny">Deny</button></form></html>`);
  }

  async handleConsent(req: Request, res: Response): Promise<void> {
    const { consent, csrf, decision } = req.body || {};
    const invalid = () => res.status(400).type('text/plain').send('Consent request is invalid or expired. Restart sign-in.');
    if (typeof consent !== 'string' || typeof csrf !== 'string' || !['allow', 'deny'].includes(decision)) { invalid(); return; }
    const record = await this.store.get<ConsentRecord>(`consent:${consent}`);
    const secure = new URL(this.opts.serverUrl).protocol === 'https:';
    const cookieName = secure ? '__Host-mcp-consent' : 'mcp-consent';
    const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
    if (!record || !timingSafeEqual(Buffer.from(record.csrfHash), Buffer.from(tokenHash(csrf))) ||
        !timingSafeEqual(Buffer.from(record.browserHash), Buffer.from(tokenHash(cookie)))) { invalid(); return; }
    const consumed = await this.store.take<ConsentRecord>(`consent:${consent}`);
    if (!consumed || consumed.grant.gitlabExpiresAt <= Date.now()) { invalid(); return; }
    res.clearCookie(cookieName, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const redirect = new URL(consumed.grant.redirectUri);
    if (decision === 'allow') {
      const code = randomToken();
      await this.store.set(tokenKey('code', code), consumed.grant, AUTH_FLOW_TTL_MS);
      redirect.searchParams.set('code', code);
    } else {
      redirect.searchParams.set('error', 'access_denied');
    }
    if (consumed.grant.clientState) redirect.searchParams.set('state', consumed.grant.clientState);
    res.redirect(redirect.toString());
  }

  /** SDK validates PKCE before atomically consuming a code. */
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const record = await this.store.get<IssuedCode>(tokenKey('code', code));
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Authorization code is invalid or expired');
    return record.clientCodeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL,
  ): Promise<OAuthTokens> {
    const key = tokenKey('code', code);
    const record = await this.store.get<IssuedCode>(key);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Authorization code is invalid or expired');
    if (redirectUri && redirectUri !== record.redirectUri) throw new InvalidGrantError('Authorization redirect URI does not match');
    if (resource && resource.toString().replace(/\/$/, '') !== this.opts.serverUrl.replace(/\/$/, '')) throw new InvalidTargetError('Resource does not match');
    const consumed = await this.store.take<IssuedCode>(key);
    if (!consumed) throw new InvalidGrantError('Authorization code is invalid or expired');
    return this.mintTokens(consumed);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = tokenKey('rt', refreshToken);
    const record = await this.store.get<RefreshTokenRecord>(key);
    if (!record || record.clientId !== client.client_id) throw new InvalidGrantError('Refresh token is invalid');
    if (scopes?.some(scope => !record.scopes.includes(scope))) throw new InvalidGrantError('Refresh scope cannot expand the grant');
    if (resource && resource.toString().replace(/\/$/, '') !== this.opts.serverUrl.replace(/\/$/, '')) throw new InvalidTargetError('Resource does not match');
    const consumed = await this.store.take<RefreshTokenRecord>(key);
    if (!consumed) throw new InvalidGrantError('Refresh token is invalid');
    // Retain a short revocation window for logout racing with rotation without
    // accumulating a month of consumed-token indexes for every active user.
    await this.store.set(`token:${tokenHash(refreshToken)}`, { familyId: consumed.familyId, clientId: consumed.clientId }, AUTH_FLOW_TTL_MS);
    await this.store.del(`at:${consumed.accessTokenHash}`);
    if (!await this.familyActive(consumed.familyId, client.client_id)) throw new InvalidGrantError('Token family is revoked or expired');
    try {
      const tokens = await this.gitlabTokenRequest({ grant_type: 'refresh_token', refresh_token: consumed.gitlabRefreshToken });
      if (!await this.userIsInAllowedGroup(tokens.access_token)) throw new InvalidGrantError('GitLab account is no longer in an allowed group');
      return await this.mintTokens({
        clientId: consumed.clientId, clientCodeChallenge: '', redirectUri: '',
        scopes: scopes?.length ? scopes : consumed.scopes, resource: consumed.resource,
        gitlabAccessToken: tokens.access_token, gitlabRefreshToken: tokens.refresh_token ?? consumed.gitlabRefreshToken,
        gitlabExpiresAt: Date.now() + (tokens.expires_in ? tokens.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
      }, consumed.familyId);
    } catch (error) {
      await this.store.del(`family:${consumed.familyId}`);
      if (error instanceof InvalidGrantError) throw error;
      throw new ServerError('GitLab refresh failed; restart sign-in');
    }
  }

  private async familyActive(id: string, clientId: string): Promise<boolean> {
    const family = await this.store.get<TokenFamily>(`family:${id}`);
    return family?.clientId === clientId;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.get<AccessTokenRecord>(tokenKey('at', token));
    if (!record || record.expiresAt * 1000 <= Date.now() || !await this.familyActive(record.familyId, record.clientId)) {
      throw new InvalidTokenError('Unknown, expired, or revoked access token');
    }
    return {
      token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt,
      resource: new URL(record.resource || this.opts.serverUrl), extra: { gitlabToken: record.gitlabAccessToken },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // The index survives rotation/consumption so logout also wins against an
    // in-flight refresh. It contains hashes and family ownership, never tokens.
    const hash = tokenHash(request.token);
    const record = await this.store.get<{ familyId: string; clientId: string }>(`token:${hash}`);
    if (!record || record.clientId !== client.client_id) return;
    await this.store.del(`family:${record.familyId}`);
    await this.store.del(`at:${hash}`);
    await this.store.del(`rt:${hash}`);
  }

  dispose(): void { this.store.dispose(); }

  private async mintTokens(record: IssuedCode, existingFamily?: string): Promise<OAuthTokens> {
    const ttlMs = record.gitlabExpiresAt - Date.now();
    if (ttlMs <= 0) throw new InvalidGrantError('GitLab authorization has expired; restart sign-in');
    const familyId = existingFamily || randomToken();
    if (existingFamily) {
      if (!await this.familyActive(familyId, record.clientId)) throw new InvalidGrantError('Token family is revoked or expired');
    } else {
      await this.store.set<TokenFamily>(`family:${familyId}`, { clientId: record.clientId }, REFRESH_TOKEN_TTL_MS);
    }
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAt = Math.floor((Date.now() + ttlMs) / 1000);
    await this.store.set(`token:${tokenHash(accessToken)}`, { familyId, clientId: record.clientId }, ttlMs);
    if (record.gitlabRefreshToken) await this.store.set(`token:${tokenHash(refreshToken)}`, { familyId, clientId: record.clientId }, REFRESH_TOKEN_TTL_MS);
    await this.store.set<AccessTokenRecord>(tokenKey('at', accessToken), {
      familyId, clientId: record.clientId, scopes: record.scopes, resource: record.resource,
      gitlabAccessToken: record.gitlabAccessToken, expiresAt,
    }, ttlMs);
    if (record.gitlabRefreshToken) await this.store.set<RefreshTokenRecord>(tokenKey('rt', refreshToken), {
      familyId, clientId: record.clientId, scopes: record.scopes, resource: record.resource,
      gitlabRefreshToken: record.gitlabRefreshToken, accessTokenHash: tokenHash(accessToken),
    }, REFRESH_TOKEN_TTL_MS);
    return { access_token: accessToken, token_type: 'Bearer', expires_in: Math.floor(ttlMs / 1000),
      scope: record.scopes.join(' '), ...(record.gitlabRefreshToken ? { refresh_token: refreshToken } : {}) };
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
    return fetchBuffered(`${this.opts.gitlabBaseUrl.replace(/\/$/, '')}/api/v4${path}`, {
      headers: { Authorization: `Bearer ${gitlabAccessToken}`, Accept: 'application/json' },
    }, this.opts.timeoutMs);
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
