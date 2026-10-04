import { jest } from '@jest/globals';
import type { SpiedFunction } from 'jest-mock';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { GitLabMCPServer, createOriginGuard } from './index.js';

// Exercise SDK schema discovery, validation, routing, and the actual REST client.
describe('MCP tool calls', () => {
  let client: Client;
  let server: Server;
  let fetchMock: SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    const service = new GitLabMCPServer();
    server = (service as unknown as { createServer(): Server }).createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'regression-client', version: '1.0.0' });
    await client.connect(clientTransport);
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 123 }), { status: 201 }),
    );
  });

  afterEach(async () => {
    fetchMock.mockRestore();
    await client.close();
    await server.close();
  });

  it.each(['object', 'string'])('sends nested REST bodies supplied as %s (#41)', async format => {
    const body = { body: 'comment text', position: { position_type: 'text', new_line: 1760 } };
    const listed = await client.listTools();
    const schema = listed.tools.find(t => t.name === 'execute_rest_write')!.inputSchema;
    expect(schema.properties).toHaveProperty('body');
    const result = await client.callTool({ name: 'execute_rest_write', arguments: {
      method: 'POST', path: '/projects/foo%2Fbar/merge_requests/18/discussions',
      body: format === 'string' ? JSON.stringify(body) : body,
      userCredentials: { accessToken: 'per-user-test-token' },
    } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v4/projects/foo%2Fbar/merge_requests/18/discussions');
    expect(JSON.parse(init!.body as string)).toEqual(body);
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer per-user-test-token');
    expect(result.structuredContent).toEqual({ id: 123 });
    expect(result.content).toEqual([{ type: 'text', text: '{\n  "id": 123\n}' }]);
  });

  it('returns tool errors for invalid input and GitLab failures', async () => {
    const invalid = await client.callTool({ name: 'execute_rest_write', arguments: { method: 'GET' } });
    expect(invalid.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }));
    const failed = await client.callTool({ name: 'execute_rest_write', arguments: {
      method: 'POST', path: '/projects/42/issues', body: { title: 'x' },
      userCredentials: { accessToken: 'test' },
    } });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: 'text', text: expect.stringContaining('Forbidden') }]);
  });

  it('rejects malformed JSON body strings before fetching', async () => {
    const result = await client.callTool({ name: 'execute_rest_write', arguments: {
      method: 'POST', path: '/projects', body: '{', userCredentials: { accessToken: 'test' },
    } });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns valid text for 204 responses', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const result = await client.callTool({ name: 'execute_rest_write', arguments: {
      method: 'DELETE', path: '/projects/42', userCredentials: { accessToken: 'test' },
    } });
    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
    expect(result.isError).toBeUndefined();
  });

  it('keeps unknown tools as protocol errors', async () => {
    await expect(client.callTool({ name: 'missing_tool', arguments: {} })).rejects.toThrow(/not found/);
  });
});

describe('HTTP origin validation', () => {
  it.each([undefined, 'https://mcp.example.com', 'null', 'https://evil.example.com'])('validates Origin %s', origin => {
    const guard = createOriginGuard(new Set(['https://mcp.example.com']));
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    guard({ headers: { origin } } as any, res as any, next);
    if (origin === undefined || origin === 'https://mcp.example.com') {
      expect(next).toHaveBeenCalledTimes(1);
    } else {
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
});
