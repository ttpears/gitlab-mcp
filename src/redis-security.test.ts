import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { GitLabOAuthProvider, type KvStore } from './oauth.js';
import { createOAuthStore } from './oauth-store.js';
import { jest } from '@jest/globals';

// CI always supplies Redis; local runs can supply REDIS_TEST_URL to exercise it.
const suite = process.env.REDIS_TEST_URL ? describe : describe.skip;
suite('encrypted OAuth state across real Redis replicas', () => {
  let raw: Redis;
  let a: KvStore;
  let b: KvStore;
  let prefix: string;
  const secret = 'e'.repeat(64);
  beforeEach(async () => {
    prefix = `security-test-${randomUUID()}`;
    raw = new Redis(process.env.REDIS_TEST_URL!);
    a = await createOAuthStore({ redisUrl: process.env.REDIS_TEST_URL, keyPrefix: prefix, encryptionKey: secret });
    b = await createOAuthStore({ redisUrl: process.env.REDIS_TEST_URL, keyPrefix: prefix, encryptionKey: secret });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const keys = await raw.keys(prefix + ':*');
    if (keys.length) await raw.del(...keys);
    a.dispose(); b.dispose(); await raw.quit();
  });

  it('atomically consumes an encrypted record on exactly one replica and preserves TTL', async () => {
    await a.set('one-time', { secret: 'fake-sensitive-state' }, 60000);
    const stored = await raw.get(prefix + ':v4:one-time');
    expect(stored).not.toContain('fake-sensitive-state');
    expect(await raw.pttl(prefix + ':v4:one-time')).toBeGreaterThan(0);
    const result = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).take('one-time')));
    expect(result.filter(Boolean)).toEqual([{ secret: 'fake-sensitive-state' }]);
  });

  it('prevents code replay and shares token-family revocation without storing plaintext credentials', async () => {
    const opts = { gitlabBaseUrl: 'https://gitlab.test', serverUrl: 'https://mcp.test', clientId: 'app', scopes: 'api', callbackPath: '/callback', timeoutMs: 1000, allowedGroups: [] };
    const providerA = new GitLabOAuthProvider(opts, a);
    const providerB = new GitLabOAuthProvider(opts, b);
    const client = { client_id: 'client', redirect_uris: ['https://client.test/cb'], token_endpoint_auth_method: 'none' as const };
    const code = 'fake-code-with-sensitive-value';
    await a.set('code:' + createHash('sha256').update(code).digest('hex'), {
      clientId: client.client_id, clientCodeChallenge: 'challenge', redirectUri: client.redirect_uris[0], scopes: ['api'],
      gitlabAccessToken: 'fake-gitlab-secret', gitlabRefreshToken: 'fake-gitlab-refresh', gitlabExpiresAt: Date.now() + 60000,
    }, 60000);
    const results = await Promise.allSettled([providerA.exchangeAuthorizationCode(client, code), providerB.exchangeAuthorizationCode(client, code)]);
    const issued = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    expect(issued).toHaveLength(1);
    await expect(providerB.verifyAccessToken(issued[0].access_token)).resolves.toHaveProperty('clientId', 'client');
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ access_token: 'rotated-gitlab', refresh_token: 'rotated-refresh', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }));
    const refreshes = await Promise.allSettled([providerA.exchangeRefreshToken(client, issued[0].refresh_token!), providerB.exchangeRefreshToken(client, issued[0].refresh_token!)]);
    const rotated = refreshes.filter(r => r.status === 'fulfilled').map(r => r.value);
    expect(rotated).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const keys = await raw.keys(prefix + ':*');
    const values = await raw.mget(...keys);
    for (const sensitive of [code, 'fake-gitlab-secret', 'fake-gitlab-refresh', issued[0].access_token, issued[0].refresh_token!, rotated[0].access_token, 'rotated-gitlab']) {
      expect(JSON.stringify({ keys, values })).not.toContain(sensitive);
    }
    await providerB.revokeToken(client, { token: issued[0].refresh_token! });
    await expect(providerA.verifyAccessToken(rotated[0].access_token)).rejects.toThrow(/revoked/);
  });
});
