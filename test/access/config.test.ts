import { describe, it, expect } from 'vitest';
import { loadMockConfig } from '../../src/access/config.js';

describe('loadMockConfig', () => {
  it('defaults to loopback bind on port 8839', () => {
    const c = loadMockConfig({});
    expect(c.bind).toBe('127.0.0.1');
    expect(c.port).toBe(8839);
    expect(c.tokenAllowlist).toEqual([]);
  });
  it('FAILS CLOSED when bind is non-loopback and no tokens are set', () => {
    expect(() => loadMockConfig({ MOCK_OPS_BIND: '0.0.0.0' }))
      .toThrow(/non-loopback bind .* requires MOCK_OPS_TOKENS/i);
  });
  it('allows non-loopback bind when a token allowlist is provided', () => {
    const c = loadMockConfig({ MOCK_OPS_BIND: '0.0.0.0', MOCK_OPS_TOKENS: 'abc,def' });
    expect(c.bind).toBe('0.0.0.0');
    expect(c.tokenAllowlist).toEqual(['abc', 'def']);
  });
  it('rejects a non-positive replay speed', () => {
    expect(() => loadMockConfig({ MOCK_REPLAY_SPEED: '0' })).toThrow(/MOCK_REPLAY_SPEED/i);
  });
});
