import { jest } from '@jest/globals';
import { GitLabOAuthProvider, InMemoryKvStore } from './oauth.js';

function response() {
  return {
    statusCode: 200, page: '', redirectTo: '', cookies: {} as Record<string, string>, headers: {} as Record<string, string>,
    status(value: number) { this.statusCode = value; return this; },
    type(_type: string) { return this; },
    send(value: string) { this.page = value; return this; },
    redirect(value: string) { this.redirectTo = value; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    cookie(name: string, value: string) { this.cookies[name] = value; return this; },
    clearCookie(name: string) { delete this.cookies[name]; return this; },
  };
}

describe('per-client OAuth consent', () => {
  let provider: GitLabOAuthProvider;
  const client = { client_id: 'untrusted-client', client_name: '<script>alert(1)</script>', redirect_uris: ['https://client.test/callback'], token_endpoint_auth_method: 'none' as const };
  beforeEach(() => {
    provider = new GitLabOAuthProvider({ gitlabBaseUrl: 'https://gitlab.test', serverUrl: 'https://mcp.test', clientId: 'app', scopes: 'api', callbackPath: '/callback', timeoutMs: 1000, allowedGroups: [] }, new InMemoryKvStore());
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ access_token: 'gitlab-secret', expires_in: 3600 }), { headers: { 'Content-Type': 'application/json' } }));
  });
  afterEach(() => { provider.dispose(); jest.restoreAllMocks(); });

  async function consentPage() {
    await provider.clientsStore.registerClient!(client);
    const auth = response();
    await provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'challenge', state: 'original-state' }, auth as any);
    const state = new URL(auth.redirectTo).searchParams.get('state')!;
    const page = response();
    await provider.handleGitLabCallback({ query: { code: 'gitlab-code', state } } as any, page as any);
    const consent = page.page.match(/name="consent" value="([^"]+)"/)![1];
    const csrf = page.page.match(/name="csrf" value="([^"]+)"/)![1];
    const cookie = Object.entries(page.cookies).map(([key, value]) => `${key}=${value}`).join('; ');
    return { page, consent, csrf, cookie };
  }

  it('shows the exact client and redirect before issuing a code and escapes untrusted metadata', async () => {
    const { page } = await consentPage();
    expect(page.redirectTo).toBe('');
    expect(page.page).toContain('https://client.test/callback');
    expect(page.page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.page).not.toContain('<script>');
    expect(page.page).not.toContain('gitlab-secret');
    expect(page.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['Cache-Control']).toBe('no-store');
    expect(page.cookies).toHaveProperty('__Host-mcp-consent');
  });

  it.each(['missing-cookie', 'wrong-cookie', 'wrong-csrf'])('rejects %s without consuming legitimate consent', async mode => {
    const { consent, csrf, cookie } = await consentPage();
    const result = response();
    await provider.handleConsent({ headers: { cookie: mode === 'missing-cookie' ? '' : mode === 'wrong-cookie' ? '__Host-mcp-consent=attacker' : cookie },
      body: { consent, csrf: mode === 'wrong-csrf' ? 'attacker' : csrf, decision: 'allow' },
    } as any, result as any);
    expect(result.statusCode).toBe(400);
    expect(result.redirectTo).toBe('');
    const valid = response();
    await provider.handleConsent({ headers: { cookie }, body: { consent, csrf, decision: 'allow' } } as any, valid as any);
    expect(new URL(valid.redirectTo).searchParams.get('code')).toBeTruthy();
  });

  it('allows only one of two concurrent approvals', async () => {
    const { consent, csrf, cookie } = await consentPage();
    const a = response(); const b = response();
    await Promise.all([a, b].map(res => provider.handleConsent({ headers: { cookie }, body: { consent, csrf, decision: 'allow' } } as any, res as any)));
    expect([a, b].filter(r => r.redirectTo)).toHaveLength(1);
    expect([a, b].filter(r => r.statusCode === 400)).toHaveLength(1);
  });

  it('returns access_denied and no code when the user declines', async () => {
    const { consent, csrf, cookie } = await consentPage();
    const result = response();
    await provider.handleConsent({ headers: { cookie }, body: { consent, csrf, decision: 'deny' } } as any, result as any);
    const redirect = new URL(result.redirectTo);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('original-state');
    expect(redirect.searchParams.has('code')).toBe(false);
  });

  it('rejects oversized dynamic-client metadata before storing it', async () => {
    await expect(provider.clientsStore.registerClient!({ ...client, client_name: 'x'.repeat(17000) })).rejects.toThrow(/16 KiB/);
    expect(await provider.clientsStore.getClient(client.client_id)).toBeUndefined();
  });
});
