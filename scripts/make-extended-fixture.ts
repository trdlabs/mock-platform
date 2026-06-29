/**
 * make-extended-fixture — replicate the committed real-day fixture
 * 2026-06-18-real-all BACKWARD two whole days into a new committed fixture
 * 2026-06-16-to-18-extended, giving ~3 continuous days of 1m CanonicalRowV2 rows.
 *
 * Downstream (trading-lab commitXTermMath) resamples these 1m rows to 1h and
 * needs >= 28 hourly bars; one real day yields only ~24. Extending BACKWARD keeps
 * the series tail pinned at 2026-06-18T23:59:00Z (a downstream-pinned anchor).
 *
 * Deterministic, network-free, no Date.now(): every historical series is
 * triplicated by shifting ONLY its timestamp field (-2d / -1d / 0d); all other
 * fields are copied verbatim. This is a synthetic extension of a real day, NOT a
 * real fetch — the manifest declares exporterVersion 'synthetic-extend.1'.
 *
 * Usage:
 *   pnpm --config.verify-deps-before-run=false exec tsx scripts/make-extended-fixture.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { scanText } from '../src/safety/secret-scan.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/contract/snapshot/version.js';
import { OPS_READ_CONTRACT_VERSION } from '../src/contract/ops-read/version.js';
import { ANALYSIS_CONTRACT_VERSION } from '../src/contract/analysis/version.js';
import { RESEARCH_READ_CONTRACT_VERSION } from '../src/contract/research-read/version.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';
import type { SnapshotBundle } from '../src/contract/snapshot/bundle.js';

const SOURCE_REF = '2026-06-18-real-all';
const OUT_REF = '2026-06-16-to-18-extended';
const DAY_MS = 86_400_000;

type TsRecord = Record<string, unknown>;

/** Replicate `arr` back 2 whole days: [-2d, -1d, original], shifting only `tsKey`. */
function triplicate(arr: readonly TsRecord[], tsKey: string): TsRecord[] {
  const shift = (delta: number): TsRecord[] =>
    arr.map((x) => ({ ...x, [tsKey]: (x[tsKey] as number) - delta }));
  return [...shift(2 * DAY_MS), ...shift(DAY_MS), ...arr];
}

/** Replace every array in a `{ [symbol]: row[] }` map with its triplicated copy, in place. */
function triplicateMap(map: Record<string, TsRecord[]>, tsKey: string): void {
  for (const sym of Object.keys(map)) map[sym] = triplicate(map[sym]!, tsKey);
}

function main(): void {
  const root = join(process.cwd(), 'data/snapshots/fixtures');
  const srcDir = join(root, SOURCE_REF);

  // Load + validate the source (also our guard that the source is intact).
  const src = loadSnapshot(srcDir);
  const srcManifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8')) as SnapshotManifest;
  if (!src.bundle.historical) throw new Error(`source fixture ${SOURCE_REF} has no historical bundle`);

  // Deep clone the whole bundle verbatim (drops readonly), then triplicate the
  // historical maps in place via a loose-typed view. Everything else stays as-is.
  const bundle = JSON.parse(JSON.stringify(src.bundle)) as SnapshotBundle;
  const hist = bundle.historical as unknown as {
    barsBySymbolAndTimeframe: Record<string, Record<string, TsRecord[]>>;
    fundingBySymbol: Record<string, TsRecord[]>;
    openInterestBySymbol: Record<string, TsRecord[]>;
    liquidationsBySymbol: Record<string, TsRecord[]>;
    rowsBySymbol?: Record<string, TsRecord[]>;
  };

  if (hist.rowsBySymbol) triplicateMap(hist.rowsBySymbol, 'minute_ts');
  triplicateMap(hist.fundingBySymbol, 'tsMs');
  triplicateMap(hist.openInterestBySymbol, 'tsMs');
  triplicateMap(hist.liquidationsBySymbol, 'tsMs');
  for (const byTf of Object.values(hist.barsBySymbolAndTimeframe)) triplicateMap(byTf, 'tsMs');

  const bundleStr = JSON.stringify(bundle);

  const hits = scanText(bundleStr);
  if (hits.length > 0) throw new Error(`secret-scan tripped on extended bundle: ${hits.join(', ')}`);

  const manifest: SnapshotManifest = {
    ref: OUT_REF,
    createdAtMs: srcManifest.createdAtMs, // deterministic; the underlying data's capture time
    versions: {
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      opsReadContractVersion: OPS_READ_CONTRACT_VERSION,
      researchReadContractVersion: RESEARCH_READ_CONTRACT_VERSION,
      analysisContractVersion: ANALYSIS_CONTRACT_VERSION,
      exporterVersion: 'synthetic-extend.1',
      sourcePlatformCommit: `synthetic-extend-of:${SOURCE_REF}`,
      redactionPolicyVersion: srcManifest.versions.redactionPolicyVersion,
    },
    bundleRef: 'ops/bundle.json',
    checksumsRef: 'checksums.json',
  };

  const out = join(root, OUT_REF);
  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, 'ops', 'bundle.json'), bundleStr);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Self-validation: re-run the full loader gate chain on what we just wrote.
  loadSnapshot(out);

  const rowsMap = hist.rowsBySymbol ?? {};
  const syms = Object.keys(rowsMap);
  const sym0 = syms[0];
  const sample = sym0 ? `${rowsMap[sym0]!.length} rows/${sym0}` : 'no rows';
  console.log(`extended fixture '${OUT_REF}' written: ${syms.length} symbols, ${sample} → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
