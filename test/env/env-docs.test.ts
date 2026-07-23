import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envSchemaDocument } from '../../src/env.js';
import { renderEnvMd, renderEnvExample } from '../../scripts/env-docs.js';

// Contract gate «Генерация»: ENV.md / .env.example are DERIVED from the schema. This test is the
// in-repo drift gate — regenerating must reproduce the committed bytes exactly.
describe('env docs generation (npm run env:docs)', () => {
  const doc = envSchemaDocument();

  it('committed ENV.md matches the render of the current schema', () => {
    expect(readFileSync(resolve('ENV.md'), 'utf8')).toBe(renderEnvMd(doc));
  });

  it('committed .env.example matches the render of the current schema', () => {
    expect(readFileSync(resolve('.env.example'), 'utf8')).toBe(renderEnvExample(doc));
  });

  it('secret variables render as bare NAME= with the SOPS/age pointer, never a value', () => {
    const example = renderEnvExample(doc);
    for (const v of doc.variables.filter((v) => v.secret)) {
      expect(example).toMatch(new RegExp(`^${v.name}=$`, 'm'));
      expect(example).toMatch(/SOPS\/age/);
    }
  });

  it('optional variables without a default render commented out', () => {
    const example = renderEnvExample(doc);
    for (const v of doc.variables.filter((v) => !v.secret && !v.required && v.default === null)) {
      expect(example).toMatch(new RegExp(`^# ${v.name}=$`, 'm'));
    }
  });

  it('variables with a default render as NAME=default', () => {
    const example = renderEnvExample(doc);
    expect(example).toMatch(/^MOCK_OPS_PORT=8839$/m);
    expect(example).toMatch(/^MOCK_SNAPSHOT_REF=fixtures\/2026-06-22-to-2026-06-28-vps$/m);
  });

  it('ENV.md lists every variable exactly once', () => {
    const md = readFileSync(resolve('ENV.md'), 'utf8');
    for (const v of doc.variables) {
      const rows = md.split('\n').filter((l) => l.startsWith(`| \`${v.name}\` `));
      expect(rows, v.name).toHaveLength(1);
    }
  });
});
