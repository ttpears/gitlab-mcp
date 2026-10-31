import { jest } from '@jest/globals';
import { GitLabGraphQLClient, Semaphore } from './gitlab-client.js';
import { ConfigSchema } from './config.js';
import { retryAfterSeconds } from './http.js';

const config = ConfigSchema.parse({ token: 'test-only', allowSharedEscapeHatch: true });
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

describe('request retries', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('retries a REST read and preserves the final status and retry metadata', async () => {
    jest.useFakeTimers();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ message: 'Unavailable' }, 503));
    const client = new GitLabGraphQLClient(config);
    const assertion = expect(client.executeRestRead('/version')).rejects.toMatchObject({
      code: 'MAX_RETRIES_EXCEEDED', statusCode: 503, isRetryable: true,
    });
    await jest.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('honors REST Retry-After before retrying a rate-limited read', async () => {
    jest.useFakeTimers();
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => json({ message: 'Slow down' }, 429, { 'Retry-After': '2' }))
      .mockImplementationOnce(async () => json({ version: '19.0' }));
    const assertion = expect(new GitLabGraphQLClient(config).executeRestRead('/version')).resolves.toEqual({ version: '19.0' });
    await jest.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts HTTP-date and zero Retry-After values and rejects invalid values', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T12:00:00Z'));
    expect(retryAfterSeconds('Sat, 31 Oct 2026 12:00:03 GMT')).toBe(3);
    expect(retryAfterSeconds('0')).toBe(0);
    expect(retryAfterSeconds('invalid')).toBeUndefined();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('does not replay a REST %s after a server error', async method => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ message: 'Write outcome unknown' }, 503));
    await expect(new GitLabGraphQLClient(config).executeRestWrite(method, '/projects/1/issues')).rejects.toMatchObject({ statusCode: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not replay a GraphQL mutation, including an undeclared custom mutation', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ errors: [{ message: 'Unknown write outcome' }] }, 500));
    await expect(new GitLabGraphQLClient(config).executeCustomQuery('mutation { createNote(input: {}) { note { id } } }')).rejects.toMatchObject({ statusCode: 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries GraphQL reads after native fetch network errors', async () => {
    jest.useFakeTimers();
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      .mockImplementationOnce(async () => json({ data: { currentUser: { username: 'alice' } } }));
    const assertion = expect(new GitLabGraphQLClient(config).getCurrentUser()).resolves.toEqual({ currentUser: { username: 'alice' } });
    await jest.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])('does not retry authentication failure %s', async status => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ message: 'Denied' }, status));
    await expect(new GitLabGraphQLClient(config).executeRestRead('/version')).rejects.toMatchObject({ statusCode: status, isRetryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels a retry backoff without issuing another request', async () => {
    jest.useFakeTimers();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ message: 'Unavailable' }, 503));
    const controller = new AbortController();
    const client = new GitLabGraphQLClient(config);
    const assertion = expect(client.withRequestSignal(controller.signal, () => client.executeRestRead('/version'))).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(100);
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('removes cancelled requests from the concurrency queue', async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = expect(semaphore.acquire(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await waiting;
  expect(semaphore.queued).toBe(0);
  release();
  const nextRelease = await semaphore.acquire();
  nextRelease();
});
