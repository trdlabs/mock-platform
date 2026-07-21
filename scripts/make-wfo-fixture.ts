import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { bundleRefForByteLength, encodeBundleFileBytes, decodeBundleFileBytes } from '../src/snapshot/bundle-io.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';

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

export function filterBarsToWindow<B extends { tsMs: number }>(
  bars: Record<string, Record<string, ReadonlyArray<B>>>,
  fromMs: number,
  toMs: number,
): Record<string, Record<string, B[]>> {
  const out: Record<string, Record<string, B[]>> = {};
  for (const [sym, tfs] of Object.entries(bars)) {
    out[sym] = {};
    for (const [tf, arr] of Object.entries(tfs)) out[sym]![tf] = arr.filter((b) => b.tsMs >= fromMs && b.tsMs < toMs);
  }
  return out;
}

interface SrcHistorical {
  rowsBySymbol?: Record<string, Array<{ minute_ts: number }>>;
  barsBySymbolAndTimeframe: Record<string, Record<string, Array<{ tsMs: number }>>>;
  fundingBySymbol: Record<string, unknown[]>;
  openInterestBySymbol: Record<string, unknown[]>;
  liquidationsBySymbol: Record<string, unknown[]>;
}

export interface WriteWfoOpts {
  source: string; out: string; symbols: string[];
  fromMs: number; toMs: number;
  totalGapBudgetMinutes: number; maxConsecutiveGapMinutes: number;
  ranking?: unknown; // ranking-provenance object (from wfo-rank) — embedded verbatim into provenance
}

export function writeWfoFixture(opts: WriteWfoOpts): { bundleRef: string; gridSize: number } {
  const { source, out, symbols, fromMs, toMs, totalGapBudgetMinutes, maxConsecutiveGapMinutes, ranking } = opts;
  if (symbols.length !== 5) throw new Error(`expected exactly 5 symbols, got ${symbols.length}`);

  const srcManifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as { versions: Record<string, string>; bundleRef: string };
  const src = loadSnapshot(source).bundle as unknown as { historical?: SrcHistorical; [k: string]: unknown };
  const h = src.historical;
  if (!h?.rowsBySymbol) throw new Error('source has no historical.rowsBySymbol');

  const rawRows: Record<string, number> = {};
  for (const s of symbols) rawRows[s] = (h.rowsBySymbol[s] ?? []).length;

  const { grid, filtered, perSymbol } = intersectToCommonGrid(h.rowsBySymbol, symbols, fromMs, toMs);
  const pick = <V>(obj: Record<string, V>): Record<string, V> => Object.fromEntries(symbols.filter((s) => s in obj).map((s) => [s, obj[s]!]));
  const historical: SrcHistorical = {
    barsBySymbolAndTimeframe: filterBarsToWindow(pick(h.barsBySymbolAndTimeframe), fromMs, toMs),
    fundingBySymbol: pick(h.fundingBySymbol),
    openInterestBySymbol: pick(h.openInterestBySymbol),
    liquidationsBySymbol: pick(h.liquidationsBySymbol),
    rowsBySymbol: filtered,
  };
  const fixture = { ...src, historical };
  const bundleBytes = Buffer.from(JSON.stringify(fixture), 'utf8');
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
    totalGapBudgetMinutes,
    maxConsecutiveGapMinutes,
  }, null, 2));

  // provenance.json — descriptive; hash is over the RAW pre-gzip source bundle bytes
  const rawSourceBytes = decodeBundleFileBytes(readFileSync(join(source, srcManifest.bundleRef)), srcManifest.bundleRef);
  writeFileSync(join(out, 'provenance.json'), JSON.stringify({
    note: 'rows filtered to the intersection of the 5 source series',
    rawSourceRef: source,
    rawSourceBundleSha256: sha256Hex(rawSourceBytes),
    window: { fromMs, toMs },
    commonGridSize: grid.length,
    rankingTieBreak: 'top-4 by summed 1m turnover excl. HUSDT, ties by symbol ASC',
    // proves WHY these 4 were chosen: turnover-map hash, candidate count, selected+rank+turnover, probe window
    ...(ranking !== undefined ? { ranking } : {}),
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
  const res = writeWfoFixture({
    source: arg('source'),
    out: arg('out'),
    symbols: arg('symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    fromMs: Number(arg('from')),
    toMs: Number(arg('to')),
    totalGapBudgetMinutes: Number(arg('total-gap-budget')),
    maxConsecutiveGapMinutes: Number(arg('max-consecutive-gap')),
    ...(rankingPath ? { ranking: JSON.parse(readFileSync(rankingPath, 'utf8')) } : {}),
  });
  console.log(`wfo fixture written: grid ${res.gridSize} min, bundleRef ${res.bundleRef}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
