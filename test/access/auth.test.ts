import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { authorize } from '../../src/access/auth.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

describe('authorize', () => {
  it('allows any request when allowlist is empty (loopback-trusted)', () => {
    expect(authorize([], undefined).ok).toBe(true);
  });
  it('rejects a missing token when allowlist is non-empty', () => {
    expect(authorize([hash('secret')], undefined)).toEqual({ ok: false });
  });
  it('accepts a token whose sha256 is allowlisted', () => {
    const r = authorize([hash('secret')], 'secret');
    expect(r.ok).toBe(true);
  });
  it('rejects a token not in the allowlist', () => {
    expect(authorize([hash('secret')], 'wrong')).toEqual({ ok: false });
  });
});
