import { GitLabGraphQLClient, Semaphore } from './gitlab-client.js';
import { ConfigSchema } from './config.js';

describe('Semaphore — soft concurrency guard', () => {
  it('bounds concurrency to the limit and runs every task (queues, never rejects)', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    let done = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      done++;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBeLessThanOrEqual(2);
    expect(done).toBe(8);
  });

  it('treats a non-positive limit as unlimited', async () => {
    const sem = new Semaphore(0);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(6);
  });
});

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
