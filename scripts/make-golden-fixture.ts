/**
 * make-golden-fixture — convert the platform-side historical golden (an array of
 * 30 CanonicalRowV2 objects) into a committable mock snapshot fixture that loads
 * through the standard loadSnapshot path (checksum + manifest + compat + secret-scan
 * + bundle schema) without weakening any gate.
 *
 * The platform golden is the byte-identity source of truth for the real==mock
 * conformance contract. The rows are copied verbatim into
 * `historical.rowsBySymbol.BTCUSDT`; a second, derived symbol (see SECOND_SYMBOL)
 * shares the same minute_ts grid so multi-symbol ordering is falsifiable. The rest
 * of the bundle is a minimal but schema-valid ops surface (empty runs / health
 * "unavailable") so the fixture exercises only the historical-rows path.
 *
 * Authoring-side tool (like make-fixture / fetch-snapshot): deterministic, no
 * network, reads a fixed input and writes a fixed output.
 *
 * The byte-identity input is the *vendored* copy committed under
 * test/conformance/_vendored/platform-historical-golden.json (CI-self-contained,
 * symmetric to the vendored conformance harness). PLATFORM_GOLDEN overrides it for
 * re-vendoring from the live platform repo.
 *
 * Usage:
 *   pnpm --config.verify-deps-before-run=false exec tsx scripts/make-golden-fixture.ts
 *   PLATFORM_GOLDEN=/path/to/MANIFEST.json pnpm exec tsx scripts/make-golden-fixture.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { scanText } from '../src/safety/secret-scan.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/contract/snapshot/version.js';
import { OPS_READ_CONTRACT_VERSION } from '../src/contract/ops-read/version.js';
import { ANALYSIS_CONTRACT_VERSION } from '../src/contract/analysis/version.js';
import { RESEARCH_READ_CONTRACT_VERSION } from '../src/contract/research-read/version.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';
import type { SnapshotBundle } from '../src/contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../src/contract/historical-read/dto.js';

const REF = 'historical-golden';
const SYMBOL = 'BTCUSDT';
/**
 * A second, derived symbol so the fixture can exercise *multi-symbol* semantics —
 * chiefly the global (minute_ts ASC, symbol ASC) total order the platform guarantees
 * (control-center audit P1-1). A single-symbol fixture cannot falsify ordering, so the
 * shared conformance harness reports it as a skip rather than a pass.
 *
 * Two constraints shape the choice:
 *   - it must sort AFTER 'BTCUSDT', because /historical/discover sorts symbols and the
 *     harness probes symbols[0] for the golden byte-identity comparison. A symbol
 *     sorting first (e.g. 'AAAUSDT') would silently retarget that check;
 *   - its minute_ts values are the golden ones verbatim, so every timestamp ties across
 *     the two symbols and the tie-break on symbol is actually exercised.
 *
 * The BTCUSDT rows stay byte-identical to the platform golden; these are additive.
 */
const SECOND_SYMBOL = 'ETHUSDT';
const ASOF = 1735776000000; // first golden minute; deterministic, no Date.now() in health surfaces

/** Deterministic, self-contained companion rows: same minute_ts grid as the golden,
 *  integer-valued OHLCV so JSON round-trips exactly (no float artifacts). */
function deriveSecondSymbolRows(golden: readonly CanonicalRowV2[]): readonly CanonicalRowV2[] {
  return golden.map((g, i) => {
    const base = 3800 + i;
    const volume = 1000 + i;
    return {
      schema_version: 2,
      minute_ts: g.minute_ts,
      symbol: SECOND_SYMBOL,
      open: base,
      high: base + 5,
      low: base - 5,
      close: base + 2,
      volume,
      turnover: (base + 2) * volume,
      oi_total_usd: 200_000_000 + i,
      funding_rate: 0.0001,
      liq_long_usd: 10_000 + i,
      liq_short_usd: 5_000 + i,
      has_oi: true,
      has_funding: true,
      has_liquidations: true,
      taker_buy_volume_usd: 40_000 + i,
      taker_sell_volume_usd: 30_000 + i,
      has_taker_flow: true,
    };
  });
}

// Default to the vendored, committed copy so the fixture reproduces in CI without the
// platform repo. PLATFORM_GOLDEN re-points at the live platform MANIFEST for re-vendoring.
const VENDORED_GOLDEN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test/conformance/_vendored/platform-historical-golden.json',
);

/** A minimal ops bundle that satisfies BUNDLE_SCHEMA: empty collections, health surfaces
 *  reported "unavailable" (this is a historical-only fixture). */
function buildBundle(
  rows: readonly CanonicalRowV2[],
  secondRows: readonly CanonicalRowV2[],
): SnapshotBundle {
  return {
    runs: [],
    tradesByRun: {},
    eventsByRun: {},
    decisionsByRun: {},
    tradeEvidenceByTrade: {},
    runtimeHealth: { entries: [], asOf: ASOF },
    marketHealth: { status: 'down', diagnostics: {}, streamAgeMs: null, availability: 'unavailable', asOf: ASOF },
    executionHealth: { status: 'down', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: ASOF },
    coverage: { entries: [], availability: 'unavailable', asOf: ASOF },
    analysisByRun: {},
    researchByRun: {},
    replay: { frames: [] },
    historical: {
      barsBySymbolAndTimeframe: {},
      fundingBySymbol: {},
      openInterestBySymbol: {},
      liquidationsBySymbol: {},
      rowsBySymbol: { [SYMBOL]: rows, [SECOND_SYMBOL]: secondRows },
    },
  };
}

function main(): void {
  const goldenPath = process.env.PLATFORM_GOLDEN ?? VENDORED_GOLDEN;
  const rows = JSON.parse(readFileSync(goldenPath, 'utf8')) as CanonicalRowV2[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`platform golden at ${goldenPath} is not a non-empty array of rows`);
  }

  const secondRows = deriveSecondSymbolRows(rows);
  const bundle = buildBundle(rows, secondRows);
  const bundleStr = JSON.stringify(bundle);

  const hits = scanText(bundleStr);
  if (hits.length > 0) {
    throw new Error(`secret-scan tripped on golden bundle: ${hits.join(', ')}`);
  }

  const manifest: SnapshotManifest = {
    ref: REF,
    createdAtMs: ASOF,
    versions: {
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      opsReadContractVersion: OPS_READ_CONTRACT_VERSION,
      researchReadContractVersion: RESEARCH_READ_CONTRACT_VERSION,
      analysisContractVersion: ANALYSIS_CONTRACT_VERSION,
      exporterVersion: 'golden.1',
      sourcePlatformCommit: 'historical-golden',
      redactionPolicyVersion: 'redact.1',
    },
    bundleRef: 'ops/bundle.json',
    checksumsRef: 'checksums.json',
  };

  const out = join(process.cwd(), 'data/snapshots/fixtures', REF);
  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, 'ops', 'bundle.json'), bundleStr);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Self-validation: re-run the full loader gate chain on what we just wrote.
  loadSnapshot(out);

  console.log(
    `golden fixture '${REF}' written: ${rows.length} ${SYMBOL} rows `
    + `+ ${secondRows.length} derived ${SECOND_SYMBOL} rows → ${out}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
