import { createHash } from 'node:crypto';
import { GitLabOAuthProvider, buildOAuthOptions, GitLabOAuthOptions } from './oauth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

function opts(over: Partial<GitLabOAuthOptions> = {}): GitLabOAuthOptions {
  return {
    gitlabBaseUrl: 'https://gitlab.example.com',
    serverUrl: 'https://mcp.example.com',
    clientId: 'app-id',
    clientSecret: 'app-secret',
    scopes: 'api',
    callbackPath: '/gitlab/callback',
    allowedGroups: [],
    timeoutMs: 5000,
    ...over,
  };
}

function fakeRes() {
  return {
    redirectedTo: undefined as string | undefined,
    statusCode: 200,
    sentBody: undefined as string | undefined,
    redirect(url: string) {
      this.redirectedTo = url;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: string) {
      this.sentBody = body;
      return this;
    },
  };
}

const client: OAuthClientInformationFull = {
  client_id: 'client-1',
  redirect_uris: ['https://app.test/cb'],
  token_endpoint_auth_method: 'none',
} as OAuthClientInformationFull;

describe('buildOAuthOptions', () => {
  it('throws when required settings are missing', () => {
    expect(() => buildOAuthOptions({ gitlabUrl: 'https://g', timeoutMs: 1000 })).toThrow(
      /MCP_SERVER_URL.*GITLAB_OAUTH_CLIENT_ID/
    );
  });

  it('rejects non-https server URLs (except localhost)', () => {
    expect(() =>
      buildOAuthOptions({ gitlabUrl: 'https://g', serverUrl: 'http://mcp.example.com', clientId: 'x', timeoutMs: 1000 })
    ).toThrow(/https/);
    expect(() =>
      buildOAuthOptions({ gitlabUrl: 'https://g', serverUrl: 'http://localhost:8080', clientId: 'x', timeoutMs: 1000 })
    ).not.toThrow();
  });

  it('defaults scopes to api and callback to /gitlab/callback', () => {
    const o = buildOAuthOptions({ gitlabUrl: 'https://g', serverUrl: 'https://m', clientId: 'x', timeoutMs: 1000 });
    expect(o.scopes).toBe('api');
    expect(o.callbackPath).toBe('/gitlab/callback');
  });
});

describe('GitLabOAuthProvider — DCR store', () => {
  it('registers and retrieves clients', () => {
    const p = new GitLabOAuthProvider(opts());
    const stored = p.clientsStore.registerClient!(client) as OAuthClientInformationFull;
    expect(stored.client_id).toBe('client-1');
    expect(p.clientsStore.getClient('client-1')).toBe(stored);
    expect(p.clientsStore.getClient('nope')).toBeUndefined();
    p.dispose();
  });
});

describe('GitLabOAuthProvider — authorize() brokers to GitLab', () => {
  it('redirects to GitLab with the fixed callback and a fresh broker PKCE', async () => {
    const p = new GitLabOAuthProvider(opts());
    const res = fakeRes();
    await p.authorize(
      client,
      { redirectUri: 'https://app.test/cb', codeChallenge: 'client-challenge', state: 'client-state', scopes: ['api'] },
      res as any
    );
    const url = new URL(res.redirectedTo!);
    expect(url.origin + url.pathname).toBe('https://gitlab.example.com/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.example.com/gitlab/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // Broker uses its OWN challenge, never the client's.
    expect(url.searchParams.get('code_challenge')).not.toBe('client-challenge');
    // Broker state replaces the client's state.
    expect(url.searchParams.get('state')).not.toBe('client-state');
    p.dispose();
  });
});

describe('GitLabOAuthProvider — verifyAccessToken', () => {
  it('rejects unknown tokens', async () => {
    const p = new GitLabOAuthProvider(opts());
    await expect(p.verifyAccessToken('bogus')).rejects.toThrow(/Unknown or revoked/);
    p.dispose();
  });
});

describe('buildOAuthOptions — allowedGroups parsing', () => {
  it('splits a comma/space list, defaults to empty', () => {
    const base = { gitlabUrl: 'https://g', serverUrl: 'https://m', clientId: 'x', timeoutMs: 1000 };
    expect(buildOAuthOptions(base).allowedGroups).toEqual([]);
    expect(buildOAuthOptions({ ...base, allowedGroups: 'team-a, team-b  team-c' }).allowedGroups).toEqual([
      'team-a',
      'team-b',
      'team-c',
    ]);
  });
});

describe('GitLabOAuthProvider — group allow-list', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // Routes fetch by URL: GitLab token endpoint vs. the groups membership lookup.
  function mockGitLab(userGroups: Array<{ full_path: string }>) {
    global.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'glpat-user', expires_in: 7200 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/api/v4/groups')) {
        return new Response(JSON.stringify(userGroups), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;
  }

  async function runCallback(allowedGroups: string[], userGroups: Array<{ full_path: string }>) {
    const p = new GitLabOAuthProvider(opts({ allowedGroups }));
    p.clientsStore.registerClient!(client);
    const res = fakeRes();
    await p.authorize(
      client,
      { redirectUri: 'https://app.test/cb', codeChallenge: 'cc', state: 'st', scopes: ['api'] },
      res as any
    );
    const brokerState = new URL(res.redirectedTo!).searchParams.get('state')!;
    mockGitLab(userGroups);
    const cbRes = fakeRes();
    await p.handleGitLabCallback({ query: { code: 'glc', state: brokerState } } as any, cbRes as any);
    p.dispose();
    return new URL(cbRes.redirectedTo!);
  }

  it('denies a user who is not in any allowed group', async () => {
    const redirect = await runCallback(['team'], [{ full_path: 'other-org/widgets' }]);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('code')).toBeNull();
    expect(redirect.searchParams.get('state')).toBe('st');
  });

  it('admits a member of a subgroup of an allowed group', async () => {
    const redirect = await runCallback(['team'], [{ full_path: 'team/backend' }]);
    expect(redirect.searchParams.get('code')).toBeTruthy();
    expect(redirect.searchParams.get('error')).toBeNull();
  });

  it('admits an exact group match (case-insensitive)', async () => {
    const redirect = await runCallback(['Team-A'], [{ full_path: 'team-a' }]);
    expect(redirect.searchParams.get('code')).toBeTruthy();
  });
});

describe('GitLabOAuthProvider — full brokered code exchange', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('exchanges a GitLab code, mints a bearer, and surfaces the GitLab token via authInfo.extra', async () => {
    const p = new GitLabOAuthProvider(opts());
    p.clientsStore.registerClient!(client);

    // Drive authorize() to capture the broker state GitLab would echo back.
    const res = fakeRes();
    await p.authorize(
      client,
      { redirectUri: 'https://app.test/cb', codeChallenge: 'cc', state: 'st', scopes: ['api'] },
      res as any
    );
    const brokerState = new URL(res.redirectedTo!).searchParams.get('state')!;

    // GitLab token endpoint returns a user token.
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'glpat-user', refresh_token: 'glrt-user', expires_in: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    // GitLab redirects to our callback with code + broker state.
    const cbRes = fakeRes();
    await p.handleGitLabCallback({ query: { code: 'gitlab-code', state: brokerState } } as any, cbRes as any);
    const mcpCode = new URL(cbRes.redirectedTo!).searchParams.get('code')!;
    expect(new URL(cbRes.redirectedTo!).searchParams.get('state')).toBe('st');

    // SDK validates the client's PKCE against the stored challenge.
    expect(await p.challengeForAuthorizationCode(client, mcpCode)).toBe('cc');

    // Client exchanges the one-time code for an MCP bearer.
    const tokens = await p.exchangeAuthorizationCode(client, mcpCode);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    // The MCP bearer is NOT the GitLab token (no passthrough).
    expect(tokens.access_token).not.toBe('glpat-user');

    // verifyAccessToken resolves the bearer back to the per-user GitLab token.
    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('client-1');
    expect((info.extra as any).gitlabToken).toBe('glpat-user');
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The authorization code is single-use.
    await expect(p.exchangeAuthorizationCode(client, mcpCode)).rejects.toThrow(/invalid or expired/);

    // Refresh rotation: new tokens issued, the OLD access token is revoked.
    global.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'glpat-user-2', refresh_token: 'glrt-user-2', expires_in: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const oldAccess = tokens.access_token;
    const rotated = await p.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(rotated.access_token).not.toBe(oldAccess);
    await expect(p.verifyAccessToken(oldAccess)).rejects.toThrow(/Unknown or revoked/);
    const info2 = await p.verifyAccessToken(rotated.access_token);
    expect((info2.extra as any).gitlabToken).toBe('glpat-user-2');

    // The old refresh token is single-use too.
    await expect(p.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(/invalid/);
    p.dispose();
  });
});
