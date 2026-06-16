import { describe, it, expect } from 'vitest';
import { decodeId } from '../../src/ops/ids.js';

describe('decodeId', () => {
  it('accepts an opaque id of the expected kind', () => {
    expect(decodeId('run', 'r_abc123')).toBe('r_abc123');
  });
  it('throws on an empty id', () => {
    expect(() => decodeId('run', '')).toThrow(/invalid run id/i);
  });
});
