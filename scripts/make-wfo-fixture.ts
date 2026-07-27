import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { assertBundleFitsInMemory, bundleRefForByteLength, encodeBundleFileBytes, decodeBundleFileBytes } from '../src/snapshot/bundle-io.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';
import type { Timeframe } from '../src/contract/historical-read/dto.js';
import { TF_MS, CONTRACT_TIMEFRAMES } from './verify_fixtures.js';

export function intersectToCommonGrid<R extends { minute_ts: number }>(
  rowsBySymbol: Record<string, ReadonlyArray<R>>,
  symbols: string[],
  fromMs: number,
  toMs: number,
): { grid: number[]; filtered: Record<string, R[]>; perSymbol: Record<string, { inWindow: number; final: number }> } {
  const inWindow: Record<string, Set<number>> = {};
  const perSymbol: Record<string, { inWindow: number; final: number }> = {};
  for (const s of symbols) {
    const set = new Set<number>();
    for (const r of rowsBySymbol[s] ?? []) if (r.minute_ts >= fromMs && r.minute_ts < toMs) set.add(r.minute_ts);
    inWindow[s] = set;
    perSymbol[s] = { inWindow: set.size, final: 0 };
  }
  const counts = new Map<number, number>();
  for (const s of symbols) for (const t of inWindow[s]!) counts.set(t, (counts.get(t) ?? 0) + 1);
  const gridSet = new Set<number>();
  for (const [t, c] of counts) if (c === symbols.length) gridSet.add(t);
  const grid = [...gridSet].sort((a, b) => a - b);
  const filtered: Record<string, R[]> = {};
  for (const s of symbols) {
    filtered[s] = (rowsBySymbol[s] ?? []).filter((r) => gridSet.has(r.minute_ts));
    perSymbol[s]!.final = filtered[s]!.length;
  }
  return { grid, filtered, perSymbol };
}

interface DerivedRow {
  minute_ts: number;
  open: number; high: number; low: number; close: number; volume: number;
  funding_rate?: number | null;
  oi_total_usd?: number | null;
  liq_long_usd?: number | null;
  liq_short_usd?: number | null;
}

/** What `--bar-timeframes` uses when the flag is absent. A fixture-authoring default, not a rule:
 *  the verifier holds a bundle to whatever its sidecar declares, so changing this changes what a
 *  new fixture ships and declares together. */
export const DEFAULT_BAR_TIMEFRAMES: ReadonlyArray<Timeframe> = ['1h', '1d'];

/** Re-derive every historical surface from the FINAL row set, mirroring the exporter's
 *  `aggregateHistorical`. Pure; testable without parquet.
 *
 *  These surfaces must be derived, not filtered. The source bundle's bars are aggregated by the
 *  exporter BEFORE duplicate rows are collapsed, so a re-written minute is summed into its 1h/1d
 *  `volume` twice; and its funding/OI/liquidation series span the whole 50-day probe pull, so
 *  carrying them across a symbol filter alone would leak 8 days past a fixture that declares 42.
 *  Deriving from `filtered` makes every surface agree with the rows the fixture actually ships and
 *  puts them inside the declared window by construction rather than by a second filter that has to
 *  be remembered. */
export function deriveHistoricalSurfaces<R extends DerivedRow>(
  rowsBySymbol: Record<string, R[]>,
  timeframes: ReadonlyArray<Timeframe>,
): {
  barsBySymbolAndTimeframe: Record<string, Record<string, Array<{ tsMs: number; open: number; high: number; low: number; close: number; volume: number }>>>;
  fundingBySymbol: Record<string, Array<{ tsMs: number; symbol: string; rate: number }>>;
  openInterestBySymbol: Record<string, Array<{ tsMs: number; symbol: string; openInterestUsd: number }>>;
  liquidationsBySymbol: Record<string, Array<{ tsMs: number; symbol: string; side: 'long' | 'short'; sizeUsd: number }>>;
} {
  const barsBySymbolAndTimeframe: Record<string, Record<string, Array<{ tsMs: number; open: number; high: number; low: number; close: number; volume: number }>>> = {};
  const fundingBySymbol: Record<string, Array<{ tsMs: number; symbol: string; rate: number }>> = {};
  const openInterestBySymbol: Record<string, Array<{ tsMs: number; symbol: string; openInterestUsd: number }>> = {};
  const liquidationsBySymbol: Record<string, Array<{ tsMs: number; symbol: string; side: 'long' | 'short'; sizeUsd: number }>> = {};

  for (const [sym, unsorted] of Object.entries(rowsBySymbol)) {
    const rows = [...unsorted].sort((a, b) => a.minute_ts - b.minute_ts);
    barsBySymbolAndTimeframe[sym] = {};
    for (const tf of timeframes) {
      const tfMs = TF_MS[tf];
      const buckets = new Map<number, { tsMs: number; open: number; high: number; low: number; close: number; volume: number }>();
      for (const r of rows) {
        const bts = Math.floor(r.minute_ts / tfMs) * tfMs;
        const b = buckets.get(bts);
        if (!b) buckets.set(bts, { tsMs: bts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
        else {
          b.high = Math.max(b.high, r.high);
          b.low = Math.min(b.low, r.low);
          b.close = r.close;
          b.volume += r.volume;
        }
      }
      barsBySymbolAndTimeframe[sym]![tf] = [...buckets.values()].sort((a, b) => a.tsMs - b.tsMs);
    }

    fundingBySymbol[sym] = rows
      .filter((r) => r.funding_rate !== null && r.funding_rate !== undefined)
      .map((r) => ({ tsMs: r.minute_ts, symbol: sym, rate: r.funding_rate as number }));

    openInterestBySymbol[sym] = rows
      .filter((r) => r.oi_total_usd !== null && r.oi_total_usd !== undefined)
      .map((r) => ({ tsMs: r.minute_ts, symbol: sym, openInterestUsd: r.oi_total_usd as number }));

    const liq: Array<{ tsMs: number; symbol: string; side: 'long' | 'short'; sizeUsd: number }> = [];
    for (const r of rows) {
      if ((r.liq_long_usd ?? null) === null && (r.liq_short_usd ?? null) === null) continue;
      if ((r.liq_long_usd ?? 0) > 0) liq.push({ tsMs: r.minute_ts, symbol: sym, side: 'long', sizeUsd: r.liq_long_usd as number });
      if ((r.liq_short_usd ?? 0) > 0) liq.push({ tsMs: r.minute_ts, symbol: sym, side: 'short', sizeUsd: r.liq_short_usd as number });
    }
    liquidationsBySymbol[sym] = liq;
  }
  return { barsBySymbolAndTimeframe, fundingBySymbol, openInterestBySymbol, liquidationsBySymbol };
}

interface SrcHistorical {
  rowsBySymbol?: Record<string, DerivedRow[]>;
  barsBySymbolAndTimeframe: Record<string, Record<string, Array<{ tsMs: number }>>>;
  fundingBySymbol: Record<string, unknown[]>;
  openInterestBySymbol: Record<string, unknown[]>;
  liquidationsBySymbol: Record<string, unknown[]>;
}

export interface WriteWfoOpts {
  source: string; out: string; symbols: string[];
  fromMs: number; toMs: number;
  /** Derived timeframes to build AND to declare in coverage.json — one input, so the fixture cannot
   *  ship a set other than the one the gate will hold it to. */
  barTimeframes: ReadonlyArray<Timeframe>;
  totalGapBudgetMinutes: number; maxConsecutiveGapMinutes: number;
  ranking?: unknown; // ranking-provenance object (from wfo-rank) — embedded verbatim into provenance
  dedupe?: unknown;  // dedupe report (from wfo-build-raw) — embedded verbatim into provenance
  /** Decoded-size ceiling of the runtime that will LOAD this fixture (default: V8's max string
   *  length, what `loadSnapshot` actually hits). Lower it when authoring for a tighter rig. */
  maxDecodedBytes?: number;
}

/** The one sentence in provenance that explains HOW the non-primary symbols were picked, rendered
 *  from the ranking evidence the caller supplied. Returns undefined when there is no evidence — or
 *  when the evidence names no selection — so provenance never asserts a rule nothing backs. */
function describeTieBreak(ranking: unknown): string | undefined {
  if (ranking === null || typeof ranking !== 'object') return undefined;
  const r = ranking as { primary?: unknown; selected?: unknown };
  if (typeof r.primary !== 'string' || !Array.isArray(r.selected) || r.selected.length < 1) return undefined;
  return `top-${r.selected.length - 1} by summed 1m turnover excl. ${r.primary}, ties by symbol ASC`;
}

export function writeWfoFixture(opts: WriteWfoOpts): { bundleRef: string; gridSize: number } {
  const { source, out, symbols, fromMs, toMs, barTimeframes, totalGapBudgetMinutes, maxConsecutiveGapMinutes, ranking, dedupe } = opts;
  // Width is an input: how many symbols a fixture spans is a research choice (over how many series
  // a distribution is measured), not a property of the format. Only the two things the sidecar
  // schema itself demands are enforced here — non-empty and unique.
  if (symbols.length < 1) throw new Error('expected at least one symbol, got none');
  if (new Set(symbols).size !== symbols.length) throw new Error(`symbols has duplicates: ${symbols.join(',')}`);
  if (barTimeframes.length === 0) throw new Error('barTimeframes must not be empty');
  if (new Set(barTimeframes).size !== barTimeframes.length) throw new Error(`barTimeframes has duplicates: ${barTimeframes.join(',')}`);
  const unknownTf = barTimeframes.filter((t) => !CONTRACT_TIMEFRAMES.includes(t));
  if (unknownTf.length) throw new Error(`barTimeframes not in the contract: ${unknownTf.join(',')} (allowed: ${CONTRACT_TIMEFRAMES.join(',')})`);

  const srcManifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as { versions: Record<string, string>; bundleRef: string };
  const src = loadSnapshot(source).bundle as unknown as { historical?: SrcHistorical; [k: string]: unknown };
  const h = src.historical;
  if (!h?.rowsBySymbol) throw new Error('source has no historical.rowsBySymbol');

  const rawRows: Record<string, number> = {};
  for (const s of symbols) rawRows[s] = (h.rowsBySymbol[s] ?? []).length;

  const { grid, filtered, perSymbol } = intersectToCommonGrid(h.rowsBySymbol, symbols, fromMs, toMs);
  // Independent of whatever selector produced this window. The probe and the
  // fixture are separate invocations with separate --symbols and --from/--to,
  // so a window chosen for one symbol set can be handed to another that shares
  // no minute with it. Without this the writer happily produces a fixture with
  // zero rows and records `commonGridSize: 0` in provenance — an artifact that
  // loads, verifies, and measures nothing, which is far worse than a refusal.
  //
  // Placed before ANY write, so a refusal leaves no half-authored directory
  // somebody may later pick up as a fixture.
  if (grid.length === 0) {
    const inWindow = symbols.map((s) => `${s}=${perSymbol[s]!.inWindow}`).join(', ');
    throw new Error(
      `empty common grid: no minute is present in all ${symbols.length} symbols within ` +
        `[${fromMs}, ${toMs}) — rows in window per symbol: ${inWindow}. ` +
        'A fixture with zero rows is not a narrower fixture, it is an empty one: it loads, it ' +
        'verifies, and it measures nothing. Widen the window, drop the symbol that does not ' +
        'overlap, or re-run the probe for THIS symbol set — do not lower a budget.',
    );
  }
  // Every other surface is re-derived from `filtered`, so all of them agree with the shipped rows
  // and sit inside the declared window by construction. See deriveHistoricalSurfaces.
  const historical: SrcHistorical = {
    ...deriveHistoricalSurfaces(filtered, barTimeframes),
    rowsBySymbol: filtered,
  };
  const fixture = { ...src, historical };
  const bundleBytes = Buffer.from(JSON.stringify(fixture), 'utf8');
  // Before anything reaches disk: a fixture too wide to load is caught at authoring time, where
  // the operator can still change N, rather than after writing a multi-GB artifact.
  assertBundleFitsInMemory(bundleBytes.length, `${out} (${symbols.length} symbols)`, opts.maxDecodedBytes);
  const bundleRef = bundleRefForByteLength(bundleBytes.length);
  const encoded = encodeBundleFileBytes(bundleBytes, bundleRef);

  const ref = out.split('/').filter(Boolean).slice(-1)[0]!;
  const manifest: SnapshotManifest = {
    ref,
    createdAtMs: Date.now(),
    versions: { ...srcManifest.versions, exporterVersion: 'wfo-fixture.1' } as SnapshotManifest['versions'],
    bundleRef,
    checksumsRef: 'checksums.json',
  };

  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, bundleRef), encoded);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ [bundleRef]: sha256Hex(encoded) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // coverage.json — authored ONLY from opts (never from the produced bundle)
  writeFileSync(join(out, 'coverage.json'), JSON.stringify({
    schemaVersion: 'fixture-coverage.1',
    period: { fromMs, toMs },
    symbols: [...symbols].sort(),
    // canonical order: by bucket size, so two runs that pass the same set write the same sidecar
    barTimeframes: [...barTimeframes].sort((a, b) => TF_MS[a] - TF_MS[b]),
    totalGapBudgetMinutes,
    maxConsecutiveGapMinutes,
  }, null, 2));

  // provenance.json — descriptive; hash is over the RAW pre-gzip source bundle bytes
  const rawSourceBytes = decodeBundleFileBytes(readFileSync(join(source, srcManifest.bundleRef)), srcManifest.bundleRef);
  const tieBreak = describeTieBreak(ranking);
  writeFileSync(join(out, 'provenance.json'), JSON.stringify({
    note: `rows filtered to the intersection of the ${symbols.length} source series`,
    rawSourceRef: source,
    rawSourceBundleSha256: sha256Hex(rawSourceBytes),
    window: { fromMs, toMs },
    commonGridSize: grid.length,
    // Describes the ranking that actually happened, read off the evidence — never a fixed sentence.
    // Absent when no ranking evidence was supplied: there is then nothing to describe, and a claim
    // the fixture cannot back up is worse than a missing field.
    ...(tieBreak !== undefined ? { rankingTieBreak: tieBreak } : {}),
    // proves WHY the non-primary symbols were chosen: turnover-map hash, candidate count, selected+rank+turnover, probe window
    ...(ranking !== undefined ? { ranking } : {}),
    // proves HOW same-minute re-writes in the raw parquet were resolved, and how many there were
    ...(dedupe !== undefined ? { dedupe } : {}),
    perSymbol: Object.fromEntries(symbols.map((s) => {
      const raw = rawRows[s]!; const inWin = perSymbol[s]!.inWindow; const fin = perSymbol[s]!.final;
      const E = (toMs - fromMs) / 60_000;
      return [s, {
        rawRowsInProbeWindow: raw,
        rowsInSelectedWindowBeforeIntersection: inWin,
        // genuine VPS absence inside the 42d window — the data-quality signal
        missingMinutesInSelectedWindow: E - inWin,
        // the probe surplus removed by windowing (expected, NOT absence)
        droppedOutsideSelectedWindow: raw - inWin,
        finalRowsAfterIntersection: fin,
        // rows dropped because another symbol lacked that minute
        droppedByIntersection: inWin - fin,
      }];
    })),
  }, null, 2));

  loadSnapshot(out); // fail loudly if the written fixture does not load
  return { bundleRef, gridSize: grid.length };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  throw new Error(`missing required --${name}`);
}
function argMaybe(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function main(): void {
  const rankingPath = argMaybe('ranking');
  const dedupePath = argMaybe('dedupe');
  const res = writeWfoFixture({
    source: arg('source'),
    out: arg('out'),
    symbols: arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    barTimeframes: (argMaybe('bar-timeframes')?.split(',').map((t) => t.trim()).filter(Boolean) as Timeframe[]) ?? DEFAULT_BAR_TIMEFRAMES,
    fromMs: Number(arg('from')),
    toMs: Number(arg('to')),
    totalGapBudgetMinutes: Number(arg('total-gap-budget')),
    maxConsecutiveGapMinutes: Number(arg('max-consecutive-gap')),
    ...(rankingPath ? { ranking: JSON.parse(readFileSync(rankingPath, 'utf8')) } : {}),
    ...(dedupePath ? { dedupe: JSON.parse(readFileSync(dedupePath, 'utf8')) } : {}),
  });
  console.log(`wfo fixture written: grid ${res.gridSize} min, bundleRef ${res.bundleRef}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
