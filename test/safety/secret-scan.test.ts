import { describe, it, expect } from 'vitest';
import { scanForSecrets, scanText, FORBIDDEN } from '../../src/safety/secret-scan.js';

describe('scanForSecrets', () => {
  it('passes clean sanitized content', () => {
    expect(() => scanForSecrets('bundle.json', '{"runs":[{"runId":"r_opaque1"}]}')).not.toThrow();
  });
  it('fails closed on an exchange API key pattern', () => {
    expect(() => scanForSecrets('bundle.json', 'key=AKIA1234567890ABCDEF'))
      .toThrow(/forbidden pattern/i);
  });
  it('fails closed on an absolute host path', () => {
    expect(() => scanForSecrets('bundle.json', '{"p":"/home/operator/secret.log"}'))
      .toThrow(/forbidden pattern/i);
  });
  it('fails closed on a bearer/JWT-looking token', () => {
    expect(() => scanForSecrets('bundle.json', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aa.bb'))
      .toThrow(/forbidden pattern/i);
  });
});

describe('scanText (pure, reused by the CI guard)', () => {
  it('returns [] for clean content', () => {
    expect(scanText('{"runId":"r_opaque1"}')).toEqual([]);
  });
  it('returns the matched label for a forbidden pattern', () => {
    expect(scanText('key=AKIA1234567890ABCDEF')).toContain('aws access key');
  });
  it('returns multiple labels when several patterns match', () => {
    const hits = scanText('AKIA1234567890ABCDEF and postgres://u:p@h/db');
    expect(hits).toContain('aws access key');
    expect(hits).toContain('db connection url');
  });
  it('FORBIDDEN is exported and non-empty', () => {
    expect(FORBIDDEN.length).toBeGreaterThan(0);
  });
});
