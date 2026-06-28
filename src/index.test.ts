import { parseTrustProxy } from './index.js';

describe('parseTrustProxy', () => {
  it('returns undefined when unset or empty', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('')).toBeUndefined();
    expect(parseTrustProxy('   ')).toBeUndefined();
  });

  it('parses booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('On')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('off')).toBe(false);
  });

  it('parses a hop count as a number', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('passes through a subnet/list string', () => {
    expect(parseTrustProxy('loopback, uniquelocal')).toBe('loopback, uniquelocal');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
