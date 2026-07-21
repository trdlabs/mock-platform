// Build a 5-symbol raw snapshot LOCALLY from cached parquet (no VPS): 5-symbol historical merged
// with the ops from the primary-only probe bundle. Pure merge core + a thin read/write shell.
// SnapshotManifest is mock-platform's own fixture-format contract — a type-only import is correct.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../../src/snapshot/checksums.js';
import { bundleRefForByteLength, encodeBundleFileBytes, decodeBundleFileBytes } from '../../src/snapshot/bundle-io.js';
import type { SnapshotManifest } from '../../src/contract/snapshot/manifest.js';

/** Replace only the historical block; preserve ops. Pure; testable without parquet. */
export function assembleRawBundle<H>(base: Record<string, unknown>, historical: H): Record<string, unknown> {
  return { ...base, historical };
}

/** Price/size fields. These pin the bar itself, so they may never differ between two writes of the
 *  same minute — a disagreement there is about the market, not about late-arriving metrics. */
const PRICE_FIELDS = ['open', 'high', 'low', 'close', 'volume', 'turnover'] as const;

/** Derived metrics the platform fills in separately from the bar. A second write of the same minute
 *  may legitimately carry a different snapshot of these. */
const DERIVED_FIELDS = [
  'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd',
  'has_oi', 'has_funding', 'has_liquidations',
  'taker_buy_volume_usd', 'taker_sell_volume_usd', 'has_taker_flow',
  'schema_version',
] as const;

/** One row per (symbol, minute), in ascending minute order. Pure; testable without parquet.
 *
 *  The shared `readParquetDir` passes duplicates straight through, so without this the committed
 *  fixture would hold repeated minutes. Two shapes occur in the real corpus:
 *
 *  - a byte-identical re-write → collapsed silently;
 *  - a re-write whose DERIVED metrics differ → last writer wins, counted and surfaced in provenance.
 *    Measured causes: the schema_version=1→2 migration (2026-06-12) and a platform update that
 *    paused and then back-filled writes (2026-07-03). The choice is deterministic because every
 *    version of a minute lives under that minute's own date= partition, which `readParquetDir`
 *    walks schema_version-major with the part-files sorted.
 *
 *  A re-write whose PRICE fields differ still throws — that is the corruption this guard exists
 *  for — as does one that disagrees on any field belonging to neither list, so that a future column
 *  cannot be waved through as "derived" by default.
 *
 *  Rows are sorted by minute_ts on the way out: `readParquetDir` iterates date directories in
 *  filesystem order, so without this the fixture bytes would depend on the machine that built them
 *  and would not honour the contract's (minute_ts ASC) ordering. */
export function dedupeRowsBySymbol<R extends { minute_ts: number }>(
  rowsBySymbol: Record<string, R[]>,
): { rows: Record<string, R[]>; collapsed: number; resolved: number } {
  const out: Record<string, R[]> = {};
  let collapsed = 0;
  let resolved = 0;
  for (const [symbol, rows] of Object.entries(rowsBySymbol)) {
    const byMinute = new Map<number, R>();
    for (const r of rows) {
      const prev = byMinute.get(r.minute_ts);
      if (prev === undefined) {
        byMinute.set(r.minute_ts, r);
        continue;
      }
      if (JSON.stringify(prev) === JSON.stringify(r)) {
        collapsed++;
        continue;
      }
      const a = prev as unknown as Record<string, unknown>;
      const b = r as unknown as Record<string, unknown>;
      const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
      const priceDiff = differing.filter((f) => (PRICE_FIELDS as readonly string[]).includes(f));
      if (priceDiff.length > 0) {
        throw new Error(
          `conflicting duplicate row for ${symbol} @ ${r.minute_ts}: price field(s) ` +
            `${priceDiff.join(', ')} disagree — refusing to pick a winner`,
        );
      }
      const unclassified = differing.filter((f) => !(DERIVED_FIELDS as readonly string[]).includes(f));
      if (unclassified.length > 0) {
        throw new Error(
          `conflicting duplicate row for ${symbol} @ ${r.minute_ts}: unclassified field(s) ` +
            `${unclassified.join(', ')} disagree — refusing to pick a winner`,
        );
      }
      byMinute.set(r.minute_ts, r); // last writer wins, derived metrics only
      resolved++;
    }
    out[symbol] = [...byMinute.values()].sort((x, y) => x.minute_ts - y.minute_ts);
  }
  return { rows: out, collapsed, resolved };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}

async function main(): Promise<void> {
  const { readParquetDir } = await import('./fetch-snapshot.js'); // dynamic: keeps pg/hyparquet out of unit tests
  const probe = arg('probe');
  const out = arg('out');
  const parquetLocal = arg('parquet-local');
  const symbols = arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const tsFrom = Number(arg('from'));
  const tsTo = Number(arg('to'));

  const probeManifest = JSON.parse(readFileSync(join(probe, 'manifest.json'), 'utf8')) as { versions: SnapshotManifest['versions']; bundleRef: string };
  const base = JSON.parse(decodeBundleFileBytes(readFileSync(join(probe, probeManifest.bundleRef)), probeManifest.bundleRef).toString('utf8')) as Record<string, unknown>;

  let dedupeReport: Record<string, unknown> | null = null;
  const historical = await readParquetDir(parquetLocal, symbols, tsFrom, tsTo);
  if (historical.rowsBySymbol) {
    const { rows, collapsed, resolved } = dedupeRowsBySymbol(historical.rowsBySymbol);
    historical.rowsBySymbol = rows;
    console.log(`[dedupe] collapsed ${collapsed} exact duplicate row(s); resolved ${resolved} derived-metric conflict(s) last-writer-wins`);
    // NOTE: only rowsBySymbol is repaired here. readParquetDir aggregated bars/funding/OI/liquidations
    // from the pre-dedup rows, so this bundle's bars still double-count a re-written minute. That is
    // tolerated because this artifact is transient and make-wfo-fixture re-derives every surface from
    // the final rows; do not consume _raw bars directly.
    dedupeReport = {
      exactDuplicatesCollapsed: collapsed,
      derivedMetricConflictsResolved: resolved,
      policy: 'last writer wins on derived metrics (OI/funding/taker flows/schema_version); a price-field disagreement is fatal',
    };
  }
  const bytes = Buffer.from(JSON.stringify(assembleRawBundle(base, historical)), 'utf8');
  const bundleRef = bundleRefForByteLength(bytes.length);
  const encoded = encodeBundleFileBytes(bytes, bundleRef);

  const ref = out.split('/').filter(Boolean).slice(-1)[0]!;
  const manifest: SnapshotManifest = { ref, createdAtMs: Date.now(), versions: { ...probeManifest.versions }, bundleRef, checksumsRef: 'checksums.json' };
  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, bundleRef), encoded);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ [bundleRef]: sha256Hex(encoded) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // Hand the dedup outcome to make-wfo-fixture, which records it in the committed provenance.json —
  // the resolution must survive into the artifact, not just the build log.
  if (dedupeReport) writeFileSync(join(out, 'dedupe.json'), JSON.stringify(dedupeReport, null, 2));
  console.log(`raw 5-symbol snapshot written to ${out} (${symbols.join(', ')})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
