import { describe, it, expect } from '@jest/globals';
import { classifySessionRequest } from './index.js';

describe('classifySessionRequest', () => {
  it('routes a known session id to its existing transport', () => {
    expect(classifySessionRequest({
      hasKnownSession: true, sessionIdPresent: true, method: 'POST', isInitialize: false,
    })).toBe('existing');
    // method/body are irrelevant once the session is known
    expect(classifySessionRequest({
      hasKnownSession: true, sessionIdPresent: true, method: 'GET', isInitialize: false,
    })).toBe('existing');
  });

  it('treats an unknown/stale session id as expired (→ 404) regardless of method', () => {
    for (const method of ['POST', 'GET', 'DELETE']) {
      expect(classifySessionRequest({
        hasKnownSession: false, sessionIdPresent: true, method, isInitialize: false,
      })).toBe('expired');
    }
  });

  it('does NOT create a new session for a stale-id POST (the after-restart bug)', () => {
    // A POST that carries a stale session id and even looks like an initialize must
    // still be treated as expired — grafting it onto a fresh transport was the bug.
    expect(classifySessionRequest({
      hasKnownSession: false, sessionIdPresent: true, method: 'POST', isInitialize: true,
    })).toBe('expired');
  });

  it('creates a session only for a POST initialize with no session id', () => {
    expect(classifySessionRequest({
      hasKnownSession: false, sessionIdPresent: false, method: 'POST', isInitialize: true,
    })).toBe('create');
  });

  it('rejects a no-session POST that is not an initialize request', () => {
    expect(classifySessionRequest({
      hasKnownSession: false, sessionIdPresent: false, method: 'POST', isInitialize: false,
    })).toBe('bad-request');
  });

  it('rejects a no-session GET/DELETE', () => {
    expect(classifySessionRequest({
      hasKnownSession: false, sessionIdPresent: false, method: 'GET', isInitialize: false,
    })).toBe('bad-request');
    expect(classifySessionRequest({
      hasKnownSession: false, sessionIdPresent: false, method: 'DELETE', isInitialize: false,
    })).toBe('bad-request');
  });
});
