import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../../src/snapshot/checksums.js';
import { encodeBundleFileBytes, BUNDLE_GZIP_REF } from '../../src/snapshot/bundle-io.js';
import { loadSnapshot } from '../../src/snapshot/loader.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'snap-'));
  mkdirSync(join(dir, 'ops'), { recursive: true });
  const bundle = {
    runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {}, tradeEvidenceByTrade: {},
    runtimeHealth: { entries: [], asOf: 1 },
    marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
    executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
    coverage: { entries: [], availability: 'available', asOf: 1 },
    analysisByRun: {}, researchByRun: {}, replay: { frames: [] },
  };
  const bundleStr = JSON.stringify(bundle);
  writeFileSync(join(dir, 'ops', 'bundle.json'), bundleStr);
  const checksums = { 'ops/bundle.json': sha256Hex(bundleStr) };
  writeFileSync(join(dir, 'checksums.json'), JSON.stringify(checksums));
  const manifest = {
    ref: 'test', createdAtMs: 1, bundleRef: 'ops/bundle.json', checksumsRef: 'checksums.json',
    versions: {
      snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.6',
      researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
      exporterVersion: 'exp.1', sourcePlatformCommit: 'abc', redactionPolicyVersion: 'redact.1',
    },
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
});

describe('loadSnapshot', () => {
  it('loads a valid snapshot with manifest, verified checksum, and bundle', () => {
    const snap = loadSnapshot(dir);
    expect(snap.manifest.ref).toBe('test');
    expect(snap.bundle.runs).toEqual([]);
  });
  it('fails closed when the bundle checksum is wrong', () => {
    const bad = mkdtempSync(join(tmpdir(), 'snap-bad-'));
    mkdirSync(join(bad, 'ops'), { recursive: true });
    writeFileSync(join(bad, 'ops', 'bundle.json'), '{"runs":[]}');
    writeFileSync(join(bad, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': 'deadbeef' }));
    writeFileSync(join(bad, 'manifest.json'), JSON.stringify({
      ref: 'bad', createdAtMs: 1, bundleRef: 'ops/bundle.json', checksumsRef: 'checksums.json',
      versions: {
        snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.6',
        researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
        exporterVersion: 'exp.1', sourcePlatformCommit: 'abc', redactionPolicyVersion: 'redact.1',
      },
    }));
    expect(() => loadSnapshot(bad)).toThrow(/checksum mismatch/i);
  });
  it('fails closed when the bundle has an unknown field (schema additionalProperties:false)', () => {
    const bad = mkdtempSync(join(tmpdir(), 'snap-leak-'));
    mkdirSync(join(bad, 'ops'), { recursive: true });
    const leaked = {
      runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {}, tradeEvidenceByTrade: {},
      runtimeHealth: { entries: [], asOf: 1 },
      marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
      executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
      coverage: { entries: [], availability: 'available', asOf: 1 },
      analysisByRun: {}, researchByRun: {}, replay: { frames: [] },
      leaked: 'should-be-rejected',
    };
    const str = JSON.stringify(leaked);
    writeFileSync(join(bad, 'ops', 'bundle.json'), str);
    writeFileSync(join(bad, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(str) }));
    writeFileSync(join(bad, 'manifest.json'), JSON.stringify({
      ref: 'leak', createdAtMs: 1, bundleRef: 'ops/bundle.json', checksumsRef: 'checksums.json',
      versions: {
        snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.6',
        researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
        exporterVersion: 'exp.1', sourcePlatformCommit: 'abc', redactionPolicyVersion: 'redact.1',
      },
    }));
    expect(() => loadSnapshot(bad)).toThrow(/bundle failed schema/i);
  });
  it('loads a gzip-compressed bundle when bundleRef ends with .gz', () => {
    const gzDir = mkdtempSync(join(tmpdir(), 'snap-gz-'));
    mkdirSync(join(gzDir, 'ops'), { recursive: true });
    const bundle = {
      runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {}, tradeEvidenceByTrade: {},
      runtimeHealth: { entries: [], asOf: 1 },
      marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
      executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
      coverage: { entries: [], availability: 'available', asOf: 1 },
      analysisByRun: {}, researchByRun: {}, replay: { frames: [] },
    };
    const jsonBytes = Buffer.from(JSON.stringify(bundle), 'utf8');
    const gzBytes = encodeBundleFileBytes(jsonBytes, BUNDLE_GZIP_REF);
    writeFileSync(join(gzDir, 'ops', 'bundle.json.gz'), gzBytes);
    writeFileSync(join(gzDir, 'checksums.json'), JSON.stringify({ [BUNDLE_GZIP_REF]: sha256Hex(gzBytes) }));
    writeFileSync(join(gzDir, 'manifest.json'), JSON.stringify({
      ref: 'gz', createdAtMs: 1, bundleRef: BUNDLE_GZIP_REF, checksumsRef: 'checksums.json',
      versions: {
        snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.6',
        researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
        exporterVersion: 'exp.1', sourcePlatformCommit: 'abc', redactionPolicyVersion: 'redact.1',
      },
    }));
    const snap = loadSnapshot(gzDir);
    expect(snap.manifest.bundleRef).toBe(BUNDLE_GZIP_REF);
    expect(snap.bundle.runs).toEqual([]);
  });
});
