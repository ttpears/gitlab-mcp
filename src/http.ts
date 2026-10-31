/** Buffer JSON API responses while the deadline still covers the response body. */
export async function fetchBuffered(
  url: string | URL,
  options: RequestInit,
  timeoutMs: number,
  maxBytes = 16 * 1024 * 1024,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error('Request timed out');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const response = await fetch(url, { ...options, signal });
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel();
      throw new Error(`GitLab response exceeds the ${maxBytes}-byte limit`);
    }
    let body: Uint8Array<ArrayBuffer> | null = null;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new Error(`GitLab response exceeds the ${maxBytes}-byte limit`);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    // Native fetch can surface AbortError while reading a body even when the
    // controller's reason is TimeoutError. Preserve the actual cancellation cause.
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', cancel);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); cleanup(); reject(signal?.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** Retry-After permits either delay-seconds or an HTTP date. */
export function retryAfterSeconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}
