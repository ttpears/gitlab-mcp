import { jest } from '@jest/globals';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { ConfigSchema } from './config.js';

const info = (next: boolean, cursor: string | null) => ({ hasNextPage: next, endCursor: cursor, hasPreviousPage: false, startCursor: null });

describe('bounded pagination', () => {
  afterEach(() => jest.restoreAllMocks());

  it('continues from the supplied cursor and returns a cursor for the unconsumed remainder', async () => {
    const variables: any[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { variables: v } = JSON.parse(init!.body as string);
      variables.push(v);
      const last = v.after === 'page-2';
      return new Response(JSON.stringify({ data: { project: { issues: {
        nodes: last ? [{ id: '3' }] : [{ id: '1' }, { id: '2' }], pageInfo: info(true, last ? 'page-3' : 'page-2'),
      } } } }), { headers: { 'Content-Type': 'application/json' } });
    });
    const client = new GitLabGraphQLClient(ConfigSchema.parse({ token: 'test', maxPageSize: 2 }));
    const result = await client.getIssues('group/project', 3, 'page-1', true);
    expect(variables.map(v => [v.first, v.after])).toEqual([[2, 'page-1'], [1, 'page-2']]);
    expect(result).toMatchObject({ totalFetched: 3, hasMore: true, pageInfo: { endCursor: 'page-3' } });
  });

  it.each([null, 'repeated'])('fails clearly when GitLab does not advance its cursor (%s)', async cursor => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: {
      projects: { nodes: [{ id: '1' }], pageInfo: info(true, cursor) },
    } }), { headers: { 'Content-Type': 'application/json' } }));
    const client = new GitLabGraphQLClient(ConfigSchema.parse({ token: 'test' }));
    await expect(client.getProjects(10, 'repeated', true)).rejects.toThrow(/cursor did not advance/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports an inaccessible connection instead of claiming an empty complete result', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { project: null } }), { headers: { 'Content-Type': 'application/json' } }));
    const client = new GitLabGraphQLClient(ConfigSchema.parse({ token: 'test' }));
    await expect(client.getIssues('missing/project', 20, undefined, true)).rejects.toThrow(/missing or inaccessible/);
  });
});
