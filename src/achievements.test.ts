import { jest } from '@jest/globals';
import type { SpiedFunction } from 'jest-mock';
import { parse } from 'graphql';
import { ConfigSchema } from './config.js';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { tools } from './tools.js';

const gid = 'gid://gitlab/Achievements::Achievement/12';
const awardGid = 'gid://gitlab/Achievements::UserAchievement/45';
const config = ConfigSchema.parse({ gitlabUrl: 'https://gitlab.example.com', token: 'shared-full-access', maxPageSize: 2 });
const award = { id: awardGid, revokedAt: null, user: { username: 'alice' } };
function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
}
function recipients(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { group: { achievements: { nodes: [{ userAchievements: { nodes, pageInfo: { hasNextPage, endCursor } } }] } } };
}

describe('GitLab Achievements GraphQL integration', () => {
  let client: GitLabGraphQLClient;
  let fetchMock: SpiedFunction<typeof fetch>;
  beforeEach(() => {
    client = new GitLabGraphQLClient(config);
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());
  function request(index = 0) {
    const [, init] = fetchMock.mock.calls[index];
    const body = JSON.parse(init!.body as string);
    expect(() => parse(body.query)).not.toThrow();
    return body;
  }

  it('resolves GroupID into NamespaceID when creating and uses the shared full-access token', async () => {
    fetchMock.mockResolvedValueOnce(response({ group: { id: 'gid://gitlab/Group/9' } }))
      .mockResolvedValueOnce(response({ achievementsCreate: { errors: [], achievement: { id: gid, name: 'Thanks' } } }));
    const result = await client.createAchievement('team', 'Thanks', 'A contribution');
    expect(result.achievement.id).toBe(gid);
    expect(request(1).variables.input).toEqual({ namespaceId: 'gid://gitlab/Namespace/9', name: 'Thanks', description: 'A contribution' });
    expect(request(1).query).toContain('AchievementsCreateInput!');
    expect(new Headers(fetchMock.mock.calls[1][1]!.headers).get('authorization')).toBe('Bearer shared-full-access');
  });

  it('supports per-user credentials and exact username resolution when awarding', async () => {
    fetchMock.mockResolvedValueOnce(response({ user: { id: 'gid://gitlab/User/7' } }))
      .mockResolvedValueOnce(response({ achievementsAward: { errors: [], userAchievement: { id: awardGid } } }));
    await client.awardAchievement('12', ' alice ', 'Thank you', { accessToken: 'personal' });
    expect(request().variables).toEqual({ username: 'alice' });
    expect(request(1).variables.input).toEqual({ achievementId: gid, userId: 'gid://gitlab/User/7', awardMessage: 'Thank you' });
    expect(new Headers(fetchMock.mock.calls[1][1]!.headers).get('authorization')).toBe('Bearer personal');
  });

  it('updates a description to an empty string without clearing an omitted name', async () => {
    fetchMock.mockResolvedValue(response({ achievementsUpdate: { errors: [], achievement: { id: gid } } }));
    await client.updateAchievement(gid, { description: '' });
    expect(request().variables.input).toEqual({ achievementId: gid, description: '' });
  });

  it('surfaces mutation errors instead of reporting success', async () => {
    fetchMock.mockResolvedValue(response({ achievementsDelete: { errors: ['Not permitted'], achievement: null } }));
    await expect(client.deleteAchievement('12')).rejects.toThrow(/Not permitted/);
    expect(request().query).toContain('AchievementsDeleteInput!');
  });

  it('returns recipient previews with cursors and normalizes achievement filters', async () => {
    const connection = { nodes: [{ id: gid, userAchievements: { nodes: [award], pageInfo: { hasNextPage: true, endCursor: 'awards-next' } } }], pageInfo: { hasNextPage: true, endCursor: 'next' } };
    fetchMock.mockResolvedValue(response({ group: { achievements: connection } }));
    expect(await client.listAchievements('team', { first: 100, after: 'previous', includeRecipients: true, ids: ['12'] })).toEqual(connection);
    expect(request().variables).toMatchObject({ first: 2, after: 'previous', includeRecipients: true, ids: [gid] });
  });

  it('fetches multiple achievement pages from the supplied cursor up to the requested cap', async () => {
    fetchMock.mockResolvedValueOnce(response({ group: { achievements: { nodes: [{ id: '1' }, { id: '2' }], pageInfo: { hasNextPage: true, endCursor: 'next' } } } }))
      .mockResolvedValueOnce(response({ group: { achievements: { nodes: [{ id: '3' }], pageInfo: { hasNextPage: true, endCursor: 'last' } } } }));
    const result = await client.listAchievements('team', { first: 3, after: 'start', fetchAll: true });
    expect(result.totalFetched).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(request().variables).toMatchObject({ first: 2, after: 'start' });
    expect(request(1).variables).toMatchObject({ first: 1, after: 'next' });
  });

  it('fails clearly for inaccessible groups even when fetching all pages', async () => {
    fetchMock.mockResolvedValue(response({ group: null }));
    await expect(client.listAchievements('missing', { fetchAll: true })).rejects.toThrow(/Group not found/);
  });

  it('paginates recipient lookup before revoking a username award', async () => {
    fetchMock.mockResolvedValueOnce(response(recipients([{ ...award, user: { username: 'bob' } }], true, 'page-2')))
      .mockResolvedValueOnce(response(recipients([award])))
      .mockResolvedValueOnce(response({ achievementsRevoke: { errors: [], userAchievement: award } }));
    await client.revokeAchievement({ group: 'team', achievementId: '12', username: 'alice' });
    expect(request(1).variables.after).toBe('page-2');
    expect(request(2).variables.input).toEqual({ userAchievementId: awardGid });
  });

  it('rejects ambiguous multiple awards across pages without mutating', async () => {
    fetchMock.mockResolvedValueOnce(response(recipients([award], true, 'page-2')))
      .mockResolvedValueOnce(response(recipients([{ ...award, id: 'gid://gitlab/Achievements::UserAchievement/46' }])));
    await expect(client.revokeAchievement({ group: 'team', achievementId: '12', username: 'alice' })).rejects.toThrow(/Multiple active awards/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('revokes a specific award without a recipient scan', async () => {
    fetchMock.mockResolvedValue(response({ achievementsRevoke: { errors: [], userAchievement: award } }));
    await client.revokeAchievement({ userAchievementId: '45' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request().variables.input).toEqual({ userAchievementId: awardGid });
  });

  it('rejects missing awards and broken pagination without mutating', async () => {
    fetchMock.mockResolvedValueOnce(response(recipients([{ ...award, revokedAt: '2026-01-01' }])));
    await expect(client.revokeAchievement({ group: 'team', achievementId: '12', username: 'alice' })).rejects.toThrow(/No active award/);
    fetchMock.mockImplementation(async () => response(recipients([], true, 'same-cursor')));
    await expect(client.revokeAchievement({ group: 'team', achievementId: '12', username: 'alice' })).rejects.toThrow(/pagination did not advance/);
  });

  it('rejects wrong ID types and incomplete input before making a request', async () => {
    await expect(client.deleteAchievement('gid://gitlab/Issue/12')).rejects.toThrow(/Expected a numeric Achievement/);
    await expect(client.updateAchievement('12', {})).rejects.toThrow(/Provide name or description/);
    await expect(client.revokeAchievement({ achievementId: '12' })).rejects.toThrow(/all of group/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops incomplete recipient scans rather than revoking a tentative match', async () => {
    let cursor = 0;
    fetchMock.mockImplementation(async () => response(recipients(cursor === 0 ? [award] : [], true, `cursor-${++cursor}`)));
    await expect(client.revokeAchievement({ group: 'team', achievementId: '12', username: 'alice' })).rejects.toThrow(/scan reached its limit/);
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });

  it('rejects nonexistent award recipients without attempting a mutation', async () => {
    fetchMock.mockResolvedValue(response({ user: null }));
    await expect(client.awardAchievement('12', 'missing')).rejects.toThrow(/User missing not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects repeated achievement cursors', async () => {
    fetchMock.mockImplementation(async () => response({ group: { achievements: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } } }));
    await expect(client.listAchievements('team', { fetchAll: true })).rejects.toThrow(/pagination did not advance/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['create', 'update', 'delete', 'award', 'revoke'])('blocks %s with a read-only fallback token', async action => {
    const readOnly = new GitLabGraphQLClient(ConfigSchema.parse({ readToken: 'read-only' }));
    const actions: Record<string, () => Promise<unknown>> = {
      create: () => readOnly.createAchievement('team', 'Test'),
      update: () => readOnly.updateAchievement('12', { name: 'New' }),
      delete: () => readOnly.deleteAchievement('12'),
      award: () => readOnly.awardAchievement('12', 'alice'),
      revoke: () => readOnly.revokeAchievement({ userAchievementId: '45' }),
    };
    await expect(actions[action]()).rejects.toThrow(/Write operation requires/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Achievement tool schemas', () => {
  it('publishes all six tools and rejects whitespace-only names and paths', () => {
    for (const name of ['list_achievements', 'create_achievement', 'update_achievement', 'delete_achievement', 'award_achievement', 'revoke_achievement']) {
      expect(tools.find(tool => tool.name === name)).toBeDefined();
    }
    const create = tools.find(tool => tool.name === 'create_achievement')!;
    expect(() => create.inputSchema.parse({ group: '   ', name: 'Badge' })).toThrow();
    expect(() => create.inputSchema.parse({ group: 'team', name: '   ' })).toThrow();
  });
});
