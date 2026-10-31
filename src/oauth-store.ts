import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  /** Atomically read and delete a one-time record. */
  take<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  dispose(): void;
}

export class InMemoryKvStore implements KvStore {
  private readonly map = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly sweep: NodeJS.Timeout;
  constructor(private readonly prefix = 'gitlab-mcp', private readonly maxEntries = 10000) {
    this.sweep = setInterval(() => this.removeExpired(), 5 * 60 * 1000);
    this.sweep.unref();
  }
  private removeExpired(): void {
    for (const [key, value] of this.map) if (value.expiresAt <= Date.now()) this.map.delete(key);
  }
  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.map.get(this.prefix + key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { this.map.delete(this.prefix + key); return undefined; }
    return entry.value as T;
  }
  async take<T>(key: string): Promise<T | undefined> {
    // No await between the read and delete: atomic within this process.
    const entry = this.map.get(this.prefix + key);
    this.map.delete(this.prefix + key);
    return entry && entry.expiresAt > Date.now() ? entry.value as T : undefined;
  }
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value)) > 32768) throw new Error('OAuth state record exceeds the 32 KiB limit');
    if (!this.map.has(this.prefix + key) && this.map.size >= this.maxEntries) {
      this.removeExpired();
      if (this.map.size >= this.maxEntries) throw new Error('OAuth state capacity reached; retry later');
    }
    this.map.set(this.prefix + key, { value, expiresAt: Date.now() + ttlMs });
  }
  async del(key: string): Promise<void> { this.map.delete(this.prefix + key); }
  dispose(): void { clearInterval(this.sweep); }
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisKvStore implements KvStore {
  constructor(private readonly client: RedisLike, private readonly prefix: string) {}
  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.prefix + key);
    return raw === null ? undefined : JSON.parse(raw) as T;
  }
  async take<T>(key: string): Promise<T | undefined> {
    // Lua keeps this compatible with Redis versions that predate GETDEL.
    const raw = await this.client.eval("local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]); end; return v", 1, this.prefix + key);
    return raw == null ? undefined : JSON.parse(String(raw)) as T;
  }
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.client.set(this.prefix + key, JSON.stringify(value), 'PX', Math.max(1, Math.floor(ttlMs)));
  }
  async del(key: string): Promise<void> { await this.client.del(this.prefix + key); }
  dispose(): void { void this.client.quit(); }
}

/** Authenticated encryption binds each value to its namespaced storage key. */
export class EncryptedKvStore implements KvStore {
  private readonly key: Buffer;
  constructor(private readonly inner: KvStore, secret: string, private readonly namespace: string) {
    if (!/^[a-f\d]{64}$/i.test(secret)) throw new Error('OAUTH_STORAGE_ENCRYPTION_KEY must contain 64 hexadecimal characters (32 random bytes)');
    this.key = Buffer.from(secret, 'hex');
  }
  private decrypt<T>(key: string, raw: string | undefined): T | undefined {
    if (raw === undefined) return undefined;
    try {
      const [version, iv, tag, content] = raw.split('.');
      if (version !== 'v1' || !iv || !tag || !content) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      cipher.setAAD(Buffer.from(this.namespace + key));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(content, 'base64url')), cipher.final()]).toString()) as T;
    } catch { throw new Error('OAuth storage authentication failed; sign in again'); }
  }
  async get<T>(key: string): Promise<T | undefined> { return this.decrypt<T>(key, await this.inner.get<string>(key)); }
  async take<T>(key: string): Promise<T | undefined> { return this.decrypt<T>(key, await this.inner.take<string>(key)); }
  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.namespace + key));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    await this.inner.set(key, `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`, ttlMs);
  }
  async del(key: string): Promise<void> { await this.inner.del(key); }
  dispose(): void { this.inner.dispose(); }
}

export async function createOAuthStore(opts: {
  redisUrl?: string; keyPrefix: string; encryptionKey?: string; allowInsecureRedis?: boolean;
}): Promise<KvStore> {
  // A new namespace invalidates pre-hardening plaintext sessions instead of reading them.
  const prefix = `${opts.keyPrefix}:v4:`;
  if (!opts.redisUrl) return new InMemoryKvStore(prefix);
  if (!opts.encryptionKey || !/^[a-f\d]{64}$/i.test(opts.encryptionKey)) {
    throw new Error('Redis-backed OAuth requires OAUTH_STORAGE_ENCRYPTION_KEY (64 hexadecimal characters)');
  }
  let url: URL;
  try { url = new URL(opts.redisUrl); } catch { throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL'); }
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'rediss:' && !local && !opts.allowInsecureRedis) {
    throw new Error('Use rediss:// for OAuth state transport, or explicitly enable REDIS_ALLOW_INSECURE for a trusted private network');
  }
  const mod: any = await import('ioredis');
  const Redis = mod.default || mod;
  const client = new Redis(opts.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }) as RedisLike;
  return new EncryptedKvStore(new RedisKvStore(client, prefix), opts.encryptionKey, prefix);
}
