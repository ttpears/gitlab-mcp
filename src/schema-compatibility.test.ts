import { buildSchema, graphql } from 'graphql';
import { jest } from '@jest/globals';
import { GitLabGraphQLClient } from './gitlab-client.js';
import { ConfigSchema } from './config.js';

// Contract fixtures for the mutation/input variants found on GitLab instances.
// These validate generated queries; they do not claim live-version coverage.
describe('GitLab issue mutation schema compatibility', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['createIssue', 'CreateIssueInput'],
    ['issueCreate', 'IssueCreateInput'],
  ])('introspects and executes %s with %s', async (mutation, input) => {
    const schema = buildSchema(`
      type Query { version: String }
      input ${input} { projectPath: ID!, title: String!, description: String }
      type Issue { id: ID!, iid: String!, title: String!, description: String, webUrl: String!, state: String!, createdAt: String! }
      type Payload { issue: Issue, errors: [String!]! }
      type Mutation { ${mutation}(input: ${input}!): Payload }
    `);
    const seen: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { query, variables } = JSON.parse(init!.body as string);
      expect(new Headers(init!.headers).get('authorization')).toBe('Bearer user-test');
      const result = await graphql({ schema, source: query, variableValues: variables, rootValue: {
        [mutation]: ({ input: fields }: { input: { title: string } }) => {
          seen.push(fields.title);
          return { issue: { id: 'gid://gitlab/Issue/1', iid: '1', title: fields.title, description: null, webUrl: 'https://gitlab.example/g/p/-/issues/1', state: 'opened', createdAt: '2026-10-31' }, errors: [] };
        },
      } });
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    });
    const client = new GitLabGraphQLClient(ConfigSchema.parse({}));
    const result = await client.createIssue('g/p', 'Schema contract test', undefined, { accessToken: 'user-test' });
    expect(result.createIssue.issue.title).toBe('Schema contract test');
    expect(result.createIssue.errors).toEqual([]);
    expect(seen).toEqual(['Schema contract test']);
  });
});
