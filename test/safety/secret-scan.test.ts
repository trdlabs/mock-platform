import { describe, it, expect } from 'vitest';
import { scanForSecrets } from '../../src/safety/secret-scan.js';

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
