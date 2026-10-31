import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export const credentialIdentity = (req: Request): string =>
  createHash('sha256').update(req.headers.authorization || '').digest('hex');

/** Bounded per-IP and per-credential accounting; new identities cannot evict active ones. */
export function requestLimits(perMinute: number, maxInflight: number, maxGlobal = 256): RequestHandler {
  const buckets = new Map<string, { starts: number; count: number; active: number }>();
  const maxBuckets = 10000;
  let active = 0;
  return (req, res, next) => {
    if (active >= maxGlobal) {
      res.setHeader('Retry-After', '1'); res.status(429).json({ error: 'Server request capacity reached; retry later' }); return;
    }
    const now = Date.now();
    const keys = [`ip:${req.ip || req.socket.remoteAddress}`, `token:${credentialIdentity(req)}`];
    const records: Array<{ starts: number; count: number; active: number }> = [];
    for (const [index, key] of keys.entries()) {
      let record = buckets.get(key);
      if (!record) {
        if (buckets.size >= maxBuckets) {
          for (const [k, value] of buckets) if (now - value.starts >= 60000 && value.active === 0) buckets.delete(k);
        }
        if (buckets.size >= maxBuckets) {
          res.setHeader('Retry-After', '60'); res.status(429).json({ error: 'Request capacity reached; retry later' }); return;
        }
        record = { starts: now, count: 0, active: 0 };
        buckets.set(key, record);
      }
      if (now - record.starts >= 60000) { record.starts = now; record.count = 0; }
      const rate = index === 0 ? perMinute * 5 : perMinute;
      const inflight = index === 0 ? maxInflight * 5 : maxInflight;
      if (record.count >= rate || record.active >= inflight) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((60000 - now + record.starts) / 1000))));
        res.status(429).json({ error: 'Request limit reached; retry later' }); return;
      }
      records.push(record);
    }
    for (const record of records) { record.count++; record.active++; }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; for (const record of records) record.active--; } };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
