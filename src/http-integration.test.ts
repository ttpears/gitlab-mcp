import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GitLabMCPServer } from './index.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';

describe('Streamable HTTP sessions and credentials', () => {
  let upstream: Server;
  let listener: Server;
  let service: GitLabMCPServer;
  let endpoint: string;
  let previousEnv: NodeJS.ProcessEnv;
  let upstreamCalls: number;

  async function listen(server: Server) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    previousEnv = process.env;
    process.env = { ...previousEnv, NODE_ENV: 'production' };
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_READ_TOKEN;
    delete process.env.GITLAB_MCP_OAUTH;
    upstreamCalls = 0;
    upstream = createServer((req, res) => {
      upstreamCalls++;
      if (req.url === '/oauth/token') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const refreshed = new URLSearchParams(body).get('grant_type') === 'refresh_token';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: refreshed ? 'oauth-rotated' : 'oauth-alice', refresh_token: refreshed ? 'refresh-2' : 'refresh-1', expires_in: 7200 }));
        });
        return;
      }
      const username = req.headers.authorization?.replace('Bearer ', '') || 'anonymous';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { currentUser: { id: 'gid://gitlab/User/1', username, name: username } } }));
    });
    process.env.GITLAB_URL = await listen(upstream);
    service = new GitLabMCPServer();
    listener = createServer(await service.createHttpApp());
    endpoint = await listen(listener);
  });

  afterEach(async () => {
    await service.close();
    for (const server of [listener, upstream]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    process.env = previousEnv;
  });

  async function request(body: unknown, token?: string, session?: string, path = '/mcp') {
    const response = await fetch(endpoint + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const data = text.startsWith('event:') || text.startsWith('id:')
      ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5))
      : text ? JSON.parse(text) : null;
    return { response, data };
  }

  async function initialize(token?: string) {
    const init = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'http-integration', version: '1' },
    } }, token);
    expect(init.response.status).toBe(200);
    const session = init.response.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    await request({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, session);
    return session;
  }

  const currentUser = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_current_user', arguments: {} } };

  it('isolates two users and advertises and enforces output schemas', async () => {
    const alice = await initialize('alice');
    const bob = await initialize('bob');
    const a = await request(currentUser, 'alice', alice);
    const b = await request(currentUser, 'bob', bob, '/');
    expect(a.data.result.structuredContent.username).toBe('alice');
    expect(b.data.result.structuredContent.username).toBe('bob');
    const listed = await request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'alice', alice);
    expect(listed.data.result.tools.find((t: any) => t.name === 'get_current_user').outputSchema.required).toContain('username');
  });

  it('does not let a session id substitute for its bearer credential', async () => {
    const session = await initialize('alice');
    for (const token of [undefined, 'bob']) {
      const attempt = await request(currentUser, token, session);
      expect(attempt.response.status).toBe(404);
    }
    expect(upstreamCalls).toBe(0);
    expect((await request(currentUser, 'alice', session)).data.result.structuredContent.username).toBe('alice');
  });

  it('requires reinitialization after credential rotation and accepts the new identity', async () => {
    const old = await initialize('old-token');
    expect((await request(currentUser, 'rotated-token', old)).response.status).toBe(404);
    const fresh = await initialize('rotated-token');
    expect((await request(currentUser, 'rotated-token', fresh)).data.result.structuredContent.username).toBe('rotated-token');
  });

  it('returns 404 after session termination and allows reinitialization', async () => {
    const session = await initialize('alice');
    const closed = await fetch(endpoint + '/mcp', { method: 'DELETE', headers: {
      Accept: 'application/json, text/event-stream', Authorization: 'Bearer alice', 'Mcp-Session-Id': session,
      'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
    } });
    await closed.text();
    expect(closed.status).toBe(200);
    expect((await request(currentUser, 'alice', session)).response.status).toBe(404);
    await initialize('alice');
  });

  it('rejects untrusted origins before creating a session', async () => {
    const response = await fetch(endpoint + '/mcp', { method: 'POST', headers: {
      Origin: 'https://untrusted.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: '{}' });
    expect(response.status).toBe(403);
    await response.text();
    expect(upstreamCalls).toBe(0);
  });

  it('runs OAuth registration, dual PKCE, bearer validation, and refresh rotation over HTTP', async () => {
    await service.close();
    listener.closeAllConnections();
    const port = (listener.address() as AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    process.env.GITLAB_MCP_OAUTH = 'true';
    process.env.MCP_SERVER_URL = endpoint;
    process.env.GITLAB_OAUTH_CLIENT_ID = 'test-app';
    service = new GitLabMCPServer();
    listener = createServer(await service.createHttpApp());
    await new Promise<void>(resolve => listener.listen(port, '127.0.0.1', resolve));

    const denied = await request(currentUser);
    expect(denied.response.status).toBe(401);
    expect(denied.response.headers.get('www-authenticate')).toContain('resource_metadata');
    const registered = await fetch(endpoint + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }) });
    expect(registered.status).toBe(201);
    const registration = await registered.json() as { client_id: string };
    const verifier = 'a'.repeat(64);
    const authorize = new URL(endpoint + '/authorize');
    authorize.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: endpoint, state: 'test-state',
    }).toString();
    const redirect = await fetch(authorize, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    await redirect.text();
    const gitlabAuth = new URL(redirect.headers.get('location')!);
    const callback = await fetch(endpoint + '/gitlab/callback?' + new URLSearchParams({ code: 'gitlab-code', state: gitlabAuth.searchParams.get('state')! }), { redirect: 'manual' });
    expect(callback.status).toBe(302);
    await callback.text();
    const clientRedirect = new URL(callback.headers.get('location')!);
    expect(clientRedirect.searchParams.get('state')).toBe('test-state');

    async function exchange(params: Record<string, string>) {
      const response = await fetch(endpoint + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: registration.client_id, resource: endpoint, ...params }),
      });
      const result = await response.json() as { access_token: string; refresh_token: string };
      expect(response.status).toBe(200);
      expect(result.access_token).toBeTruthy();
      return result;
    }

    const tokens = await exchange({ grant_type: 'authorization_code', code: clientRedirect.searchParams.get('code')!, code_verifier: verifier, redirect_uri: 'https://client.example/callback' });
    const session = await initialize(tokens.access_token);
    expect((await request(currentUser, tokens.access_token, session)).data.result.structuredContent.username).toBe('oauth-alice');
    const rotated = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    expect((await request(currentUser, tokens.access_token, session)).response.status).toBe(401);
    expect((await request(currentUser, rotated.access_token, session)).response.status).toBe(404);
    const fresh = await initialize(rotated.access_token);
    expect((await request(currentUser, rotated.access_token, fresh)).data.result.structuredContent.username).toBe('oauth-rotated');
  });
});
