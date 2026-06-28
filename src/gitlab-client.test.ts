import { GitLabGraphQLClient } from './gitlab-client.js';
import { ConfigSchema } from './config.js';

const baseConfig = ConfigSchema.parse({ gitlabUrl: 'https://gitlab.example.com' });

describe('escape-hatch tools require per-user credentials by default', () => {
  const client = new GitLabGraphQLClient({ ...baseConfig, token: 'shared-token' });

  it('blocks execute_custom_query on the shared token', async () => {
    await expect(client.executeCustomQuery('query { x }')).rejects.toThrow(/per-call user credentials/);
  });
  it('blocks execute_rest_read on the shared token', async () => {
    await expect(client.executeRestRead('/version')).rejects.toThrow(/per-call user credentials/);
  });
  it('blocks execute_rest_write on the shared token', async () => {
    await expect(client.executeRestWrite('POST', '/projects')).rejects.toThrow(/per-call user credentials/);
  });
});

describe('execute_custom_query mutation auto-detection', () => {
  it('write-gates a mutation even when shared escape-hatch is allowed on a read-only token', async () => {
    const client = new GitLabGraphQLClient({
      ...baseConfig,
      readToken: 'read-token',
      allowSharedEscapeHatch: true,
    });
    await expect(
      client.executeCustomQuery('mutation { createNote(input: {}) { note { id } } }')
    ).rejects.toThrow(/Write operation requires/);
  });
});
