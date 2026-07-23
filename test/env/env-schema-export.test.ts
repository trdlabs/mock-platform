import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { envSchemaDocument } from '../../src/env.js';

// Vendored copy of the normative contract artifact (control-center
// scripts/src/contracts/env-schema-1.schema.json, contract env-schema.1). Re-vendor on a
// contract bump — the aggregator in control-center revalidates every export anyway.
const CONTRACT_SCHEMA = JSON.parse(
  readFileSync(resolve('test/env/env-schema-1.schema.json'), 'utf8'),
) as object;

function validateAgainstContract(doc: unknown): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(CONTRACT_SCHEMA);
  return validate(doc)
    ? []
    : (validate.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`);
}

describe('envSchemaDocument — env-schema.1 export', () => {
  const doc = envSchemaDocument();

  it('passes the vendored env-schema.1 JSON Schema', () => {
    expect(validateAgainstContract(doc)).toEqual([]);
  });

  it('carries the canonical repo id and generated_from', () => {
    expect(doc.schema_version).toBe('env-schema.1');
    expect(doc.repo).toBe('trading-mock-platform');
    expect(doc.generated_from).toBe('src/env.ts');
  });

  it('variables are sorted by name and unique (semantic rules of the TS validator)', () => {
    const names = doc.variables.map((v) => v.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers the full inventoried surface of the repo', () => {
    expect(doc.variables.map((v) => v.name)).toEqual([
      'HOME',
      'MOCK_OPS_BIND',
      'MOCK_OPS_PORT',
      'MOCK_OPS_TOKENS',
      'MOCK_REPLAY_MODE',
      'MOCK_REPLAY_SPEED',
      'MOCK_RESEARCH_TOKEN',
      'MOCK_RESEARCH_TOKENS',
      'MOCK_SNAPSHOT_DB_URL',
      'MOCK_SNAPSHOT_DIR',
      'MOCK_SNAPSHOT_REF',
      'PLATFORM_GOLDEN',
      'PLATFORM_REPO',
    ]);
  });

  it('secrets carry default null and are limited to the two credentials', () => {
    const secrets = doc.variables.filter((v) => v.secret).map((v) => v.name);
    expect(secrets).toEqual(['MOCK_RESEARCH_TOKEN', 'MOCK_SNAPSHOT_DB_URL']);
    for (const v of doc.variables.filter((v) => v.secret)) {
      expect(v.default, `${v.name} is secret => default must be null`).toBeNull();
    }
  });

  it('no flags are declared (mock-platform has no E4b deploy-time flags yet)', () => {
    expect(doc.variables.every((v) => v.flag === false)).toBe(true);
  });

  it('pinned behavioural defaults survive as schema defaults', () => {
    const byName = new Map(doc.variables.map((v) => [v.name, v]));
    expect(byName.get('MOCK_OPS_PORT')!.default).toBe('8839');
    expect(byName.get('MOCK_OPS_BIND')!.default).toBe('127.0.0.1');
    expect(byName.get('MOCK_REPLAY_MODE')!.default).toBe('loop');
    expect(byName.get('MOCK_REPLAY_SPEED')!.default).toBe('1');
    expect(byName.get('MOCK_SNAPSHOT_REF')!.default).toBe('fixtures/2026-06-22-to-2026-06-28-vps');
    expect(byName.get('MOCK_OPS_TOKENS')!.default).toBe('');
  });

  it('every declared consumer is an existing repo-relative module', () => {
    for (const v of doc.variables) {
      for (const c of v.consumers) {
        expect(() => readFileSync(resolve(c)), `${v.name} -> ${c}`).not.toThrow();
      }
    }
  });

  it('negative: a mutated document (secret with default) no longer passes the contract schema', () => {
    const bad = structuredClone(doc) as unknown as { variables: Array<{ secret: boolean; default: string | null }> };
    const secretVar = bad.variables.find((v) => v.secret)!;
    secretVar.default = 'oops';
    expect(validateAgainstContract(bad)).not.toEqual([]);
  });

  it('negative: an unknown type is rejected by the contract schema', () => {
    const bad = structuredClone(doc) as unknown as { variables: Array<{ type: string }> };
    bad.variables[0]!.type = 'port';
    expect(validateAgainstContract(bad)).not.toEqual([]);
  });
});

describe('npm run env:schema — deterministic stdout export', () => {
  const TSX = resolve('node_modules/.bin/tsx');
  const run = (): string =>
    execFileSync(TSX, ['scripts/env-schema.ts'], { encoding: 'utf8', cwd: resolve('.') });

  it('prints the document as 2-space JSON with a trailing newline, byte-identical across runs', () => {
    const first = run();
    expect(first).toBe(`${JSON.stringify(envSchemaDocument(), null, 2)}\n`);
    expect(run()).toBe(first); // no timestamps — drift gates diff bytes
  });
});
