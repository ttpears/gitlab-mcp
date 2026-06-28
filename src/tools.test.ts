import { tools, readOnlyTools, writeTools } from './tools.js';

describe('tool registry integrity', () => {
  it('every tool is well-formed with a unique name', () => {
    const names = new Set<string>();
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(typeof t.description).toBe('string');
      expect(typeof t.handler).toBe('function');
      expect(typeof t.inputSchema.parse).toBe('function');
      expect(typeof t.requiresAuth).toBe('boolean');
      expect(typeof t.requiresWrite).toBe('boolean');
    }
    // The read-only and write groups are both included in the exported registry.
    for (const t of [...readOnlyTools, ...writeTools]) {
      expect(names.has(t.name)).toBe(true);
    }
  });

  it('write tools are write-gated and read tools are not', () => {
    for (const t of writeTools) expect(t.requiresWrite).toBe(true);
    for (const t of readOnlyTools) expect(t.requiresWrite).toBe(false);
  });
});

// Regression guard for the 1.15.1 / 1.18.1 bug class: handlers must always
// delegate to the client (which resolves the token via the four-step rule), never
// self-reject just because no per-call userCredentials were supplied.
describe('handler delegation without per-call credentials', () => {
  function tool(name: string) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  it('get_issues delegates to client.getIssues with undefined credentials', async () => {
    const t = tool('get_issues');
    const input = t.inputSchema.parse({ projectPath: 'group/proj' });
    const calls: any[][] = [];
    const stub: any = {
      getIssues: (...args: any[]) => {
        calls.push(args);
        return { project: { issues: { nodes: [] } } };
      },
    };
    const out = await t.handler(input, stub, undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('group/proj');
    expect(calls[0][4]).toBeUndefined(); // credentials — not supplied, not pre-rejected
    expect(out).toEqual({ nodes: [] });
  });

  it('list_my_events (me-scoped) delegates instead of rejecting when no creds', async () => {
    const t = tool('list_my_events');
    const input = t.inputSchema.parse({});
    let delegated = false;
    const stub: any = {
      listMyEvents: (_params: any, creds: any) => {
        delegated = true;
        return { nodes: [], creds };
      },
    };
    const out = await t.handler(input, stub, undefined);
    expect(delegated).toBe(true);
    expect(out.creds).toBeUndefined();
  });

  it('passes per-call userConfig through to the client when present', async () => {
    const t = tool('list_my_events');
    const input = t.inputSchema.parse({});
    const userConfig = { accessToken: 'glpat-x' };
    let seen: any;
    const stub: any = {
      listMyEvents: (_params: any, creds: any) => {
        seen = creds;
        return { nodes: [] };
      },
    };
    await t.handler(input, stub, userConfig);
    expect(seen).toEqual(userConfig);
  });
});
