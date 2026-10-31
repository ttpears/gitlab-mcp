import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { ConfigSchema } from './config.js';

describe('response body deadlines and concurrency over real HTTP', () => {
  let upstream: Server;
  let url: string;
  let bodyDelay: number;
  let active: number;
  let peak: number;
  let calls: number;

  beforeEach(async () => {
    bodyDelay = 30;
    active = peak = calls = 0;
    upstream = createServer((req, res) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      res.on('close', () => { active--; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      const timer = setTimeout(() => res.end(JSON.stringify(req.url === '/api/graphql'
        ? { data: { currentUser: { username: 'alice' } } }
        : { version: '19.0' })), bodyDelay);
      res.on('close', () => clearTimeout(timer));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });

  function client(timeout = 1000) {
    return new GitLabGraphQLClient({ ...ConfigSchema.parse({ gitlabUrl: url, token: 'test', maxConcurrency: 1, allowSharedEscapeHatch: true }), defaultTimeout: timeout });
  }

  it('holds the concurrency slot until GraphQL and REST bodies finish', async () => {
    const c = client();
    const results = await Promise.all([c.getCurrentUser(), c.executeRestRead('/version'), c.executeRestRead('/version')]);
    expect(results[0]).toEqual({ currentUser: { username: 'alice' } });
    expect(results[1]).toEqual({ version: '19.0' });
    expect(peak).toBe(1);
  });

  it.each(['REST', 'GraphQL'])('aborts a stalled %s body and releases the slot without replaying a write', async protocol => {
    bodyDelay = 10_000;
    const c = client(100);
    const write = protocol === 'REST'
      ? c.executeRestWrite('POST', '/projects/1/issues')
      : c.executeCustomQuery('mutation { createNote(input: {}) { note { id } } }');
    await expect(write).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(calls).toBe(1);
    bodyDelay = 1;
    await expect(c.executeRestRead('/version')).resolves.toEqual({ version: '19.0' });
  });

  it('propagates cancellation through a response body', async () => {
    bodyDelay = 10_000;
    const c = client();
    const controller = new AbortController();
    const result = c.withRequestSignal(controller.signal, () => c.executeRestRead('/version'));
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    setTimeout(() => controller.abort(), 100);
    await assertion;
    expect(calls).toBe(1);
  });
});
