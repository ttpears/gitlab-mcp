import { describe, it, expect } from '@jest/globals';
import { closeHttpSession } from './index.js';

type FakeServer = { close: () => Promise<void> };
type FakeSession = { server: FakeServer };

describe('closeHttpSession', () => {
  it('is a no-op for an undefined or unknown session id', () => {
    const sessions = new Map<string, FakeSession>();
    expect(() => closeHttpSession(sessions, undefined)).not.toThrow();
    expect(() => closeHttpSession(sessions, 'nope')).not.toThrow();
    expect(sessions.size).toBe(0);
  });

  it('removes the session and closes its server exactly once', () => {
    const sessions = new Map<string, FakeSession>();
    let closeCalls = 0;
    sessions.set('s1', { server: { close: () => { closeCalls++; return Promise.resolve(); } } });

    closeHttpSession(sessions, 's1');

    expect(sessions.has('s1')).toBe(false);
    expect(sessions.size).toBe(0);
    expect(closeCalls).toBe(1);
  });

  it('does not recurse when server.close() re-enters the handler (the real SDK onclose chain)', () => {
    // The SDK wires server.close() -> transport.close() -> transport.onclose, so
    // closing the server synchronously re-invokes the same close handler. Reproduce
    // that here: pre-fix this recursed until "RangeError: Maximum call stack size
    // exceeded"; with the fix it settles after a single real teardown.
    const sessions = new Map<string, FakeSession>();
    let closeCalls = 0;
    const server: FakeServer = {
      close: () => {
        closeCalls++;
        closeHttpSession(sessions, 's1'); // re-entrant, synchronous
        return Promise.resolve();
      },
    };
    sessions.set('s1', { server });

    expect(() => closeHttpSession(sessions, 's1')).not.toThrow();
    expect(closeCalls).toBe(1);
    expect(sessions.size).toBe(0);
  });

  it('never reports a negative remaining-session count, even on a double close', () => {
    const sessions = new Map<string, FakeSession>();
    sessions.set('a', { server: { close: () => Promise.resolve() } });
    sessions.set('b', { server: { close: () => Promise.resolve() } });

    const remaining: number[] = [];
    const original = console.error;
    console.error = ((msg?: unknown) => {
      const m = String(msg).match(/remaining sessions: (-?\d+)/);
      if (m) remaining.push(Number(m[1]));
    }) as typeof console.error;

    try {
      closeHttpSession(sessions, 'a');
      closeHttpSession(sessions, 'a'); // double close must stay a no-op
      closeHttpSession(sessions, 'b');
    } finally {
      console.error = original;
    }

    expect(Math.min(...remaining)).toBeGreaterThanOrEqual(0);
    expect(remaining).toEqual([1, 0]); // a -> b remains (1); b -> none remain (0)
  });
});
