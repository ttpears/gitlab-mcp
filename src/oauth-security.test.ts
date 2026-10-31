import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { GitLabOAuthProvider, type GitLabOAuthOptions, InMemoryKvStore } from './oauth.js';

const client = { client_id: 'client-a', redirect_uris: ['https://client.test/cb'], token_endpoint_auth_method: 'none' as const };
const other = { ...client, client_id: 'client-b' };
const options: GitLabOAuthOptions = { gitlabBaseUrl: 'https://gitlab.test', serverUrl: 'https://mcp.test', clientId: 'app', scopes: 'api', callbackPath: '/callback', timeoutMs: 1000, allowedGroups: [] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('OAuth one-time grants and revocation', () => {
  let store: InMemoryKvStore;
  let provider: GitLabOAuthProvider;
  beforeEach(() => { store = new InMemoryKvStore(); provider = new GitLabOAuthProvider(options, store); });
  afterEach(() => { provider.dispose(); jest.restoreAllMocks(); });

  async function code(value = 'code') {
    await store.set(`code:${hash(value)}`, {
      clientId: client.client_id, clientCodeChallenge: 'challenge', redirectUri: client.redirect_uris[0], scopes: ['api'],
      resource: 'https://mcp.test/', gitlabAccessToken: 'upstream-test-token', gitlabRefreshToken: 'upstream-test-refresh', gitlabExpiresAt: Date.now() + 60000,
    }, 60000);
    return value;
  }
  const refreshResponse = () => new Response(JSON.stringify({ access_token: 'new-upstream', refresh_token: 'new-refresh', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } });

  it('permits exactly one concurrent exchange of an authorization code', async () => {
    const value = await code();
    const result = await Promise.allSettled([provider.exchangeAuthorizationCode(client, value), provider.exchangeAuthorizationCode(client, value)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(r => r.status === 'rejected')).toHaveLength(1);
  });

  it('rejects the wrong client, redirect URI, or audience without consuming the code', async () => {
    await code();
    await expect(provider.challengeForAuthorizationCode(other, 'code')).rejects.toThrow(/invalid/);
    await expect(provider.exchangeAuthorizationCode(other, 'code')).rejects.toThrow(/invalid/);
    await expect(provider.exchangeAuthorizationCode(client, 'code', undefined, 'https://other.test')).rejects.toThrow(/redirect/);
    await expect(provider.exchangeAuthorizationCode(client, 'code', undefined, client.redirect_uris[0], new URL('https://other.test'))).rejects.toThrow(/Resource/);
    await expect(provider.exchangeAuthorizationCode(client, 'code')).resolves.toHaveProperty('access_token');
  });

  it('permits exactly one concurrent refresh and revokes the prior access token', async () => {
    const tokens = await provider.exchangeAuthorizationCode(client, await code());
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => refreshResponse());
    const result = await Promise.allSettled([provider.exchangeRefreshToken(client, tokens.refresh_token!), provider.exchangeRefreshToken(client, tokens.refresh_token!)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/revoked/);
  });

  it('revoking a refresh token invalidates its paired access token', async () => {
    const tokens = await provider.exchangeAuthorizationCode(client, await code());
    await provider.revokeToken(client, { token: tokens.refresh_token! });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/revoked/);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(/invalid|revoked/);
  });

  it('revoking an old token invalidates the family after refresh rotation', async () => {
    const tokens = await provider.exchangeAuthorizationCode(client, await code());
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => refreshResponse());
    const rotated = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    await provider.revokeToken(client, { token: tokens.refresh_token! });
    await expect(provider.verifyAccessToken(rotated.access_token)).rejects.toThrow(/revoked/);
  });

  it('revocation wins against an in-flight refresh', async () => {
    const tokens = await provider.exchangeAuthorizationCode(client, await code());
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { entered(); await blocked; return refreshResponse(); });
    const assertion = expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(/revoked/);
    await started;
    await provider.revokeToken(client, { token: tokens.refresh_token! });
    release();
    await assertion;
  });

  it('does not let another client revoke or consume a token', async () => {
    const tokens = await provider.exchangeAuthorizationCode(client, await code());
    await provider.revokeToken(other, { token: tokens.refresh_token! });
    await provider.revokeToken(other, { token: tokens.access_token });
    await expect(provider.exchangeRefreshToken(other, tokens.refresh_token!)).rejects.toThrow(/invalid/);
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toHaveProperty('clientId', client.client_id);
  });

  it.each([false, true])('fails closed on a removed group member or membership outage (outage=%s)', async outage => {
    provider = new GitLabOAuthProvider({ ...options, allowedGroups: ['team'] }, store);
    const tokens = await provider.exchangeAuthorizationCode(client, await code());
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/oauth/token')
      ? refreshResponse() : new Response(outage ? '{}' : '[]', { status: outage ? 503 : 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(outage ? /restart sign-in/ : /allowed group/);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/v4/groups'))).toBe(true);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/revoked/);
  });

  it('does not expand refresh scopes or accept a different resource', async () => {
    const tokens = await provider.exchangeAuthorizationCode(client, await code());
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, ['admin'])).rejects.toThrow(/expand/);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, undefined, new URL('https://other.test'))).rejects.toThrow(/Resource/);
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toHaveProperty('scopes', ['api']);
  });

  it('expires the token family after 30 days even if the upstream token lives longer', async () => {
    const value = await code();
    const record = await store.get<any>(`code:${hash(value)}`);
    await store.set(`code:${hash(value)}`, { ...record, gitlabExpiresAt: Date.now() + 90 * 86400000 }, 60000);
    const tokens = await provider.exchangeAuthorizationCode(client, value);
    const later = Date.now() + 31 * 86400000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/expired|revoked/);
  });
});
