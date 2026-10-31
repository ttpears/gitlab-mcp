import { EncryptedKvStore, InMemoryKvStore, createOAuthStore } from './oauth-store.js';

describe('OAuth state protection', () => {
  let raw: InMemoryKvStore;
  beforeEach(() => { raw = new InMemoryKvStore(); });
  afterEach(() => raw.dispose());

  it('atomically consumes an in-memory record', async () => {
    await raw.set('code', { id: 1 }, 1000);
    expect((await Promise.all([raw.take('code'), raw.take('code')])).filter(Boolean)).toHaveLength(1);
  });
  it('encrypts stored credentials and allows replicas with the same key to read them', async () => {
    const a = new EncryptedKvStore(raw, 'a'.repeat(64), 'test:');
    const b = new EncryptedKvStore(raw, 'a'.repeat(64), 'test:');
    await a.set('record', { token: 'gitlab-secret' }, 1000);
    expect(await raw.get<string>('record')).not.toContain('gitlab-secret');
    expect(await b.get('record')).toEqual({ token: 'gitlab-secret' });
    expect((await Promise.all([a.take('record'), b.take('record')])).filter(Boolean)).toHaveLength(1);
  });
  it('rejects tampering, moving ciphertext to another key, or a different encryption key', async () => {
    const a = new EncryptedKvStore(raw, 'a'.repeat(64), 'test:');
    await a.set('record', { token: 'secret' }, 1000);
    await raw.set('moved', await raw.get('record'), 1000);
    await expect(a.get('moved')).rejects.toThrow(/authentication/);
    await expect(new EncryptedKvStore(raw, 'b'.repeat(64), 'test:').get('record')).rejects.toThrow(/authentication/);
    await raw.set('record', 'v1.invalid.invalid.invalid', 1000);
    await expect(a.get('record')).rejects.toThrow(/authentication/);
  });
  it('bounds in-memory state instead of evicting active grants', async () => {
    const small = new InMemoryKvStore('small:', 1);
    try {
      await small.set('one', 1, 1000);
      await expect(small.set('two', 2, 1000)).rejects.toThrow(/capacity/);
      expect(await small.get('one')).toBe(1);
      await small.del('one');
      await expect(small.set('two', 2, 1000)).resolves.toBeUndefined();
    } finally { small.dispose(); }
  });
  it('rejects oversized in-memory state records', async () => {
    await expect(raw.set('large', 'x'.repeat(32769), 1000)).rejects.toThrow(/32 KiB/);
    expect(await raw.get('large')).toBeUndefined();
  });
  it('fails before connecting when Redis encryption or transport settings are insecure', async () => {
    await expect(createOAuthStore({ redisUrl: 'rediss://redis.test', keyPrefix: 'test' })).rejects.toThrow(/OAUTH_STORAGE_ENCRYPTION_KEY/);
    await expect(createOAuthStore({ redisUrl: 'redis://redis.test', keyPrefix: 'test', encryptionKey: 'a'.repeat(64) })).rejects.toThrow(/rediss/);
    expect(() => new EncryptedKvStore(raw, 'short', 'test:')).toThrow(/64 hexadecimal/);
  });
});
