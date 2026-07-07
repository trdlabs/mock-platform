/**
 * make-fixture — derive a small, committable demo fixture from a large on-disk
 * VPS snapshot by keeping only the top-N symbols by trade count.
 *
 * Authoring-side tool (like fetch-snapshot): it reads a gitignored local snapshot
 * that consumers do not have; the committed OUTPUT is what the demo serves.
 *
 * Usage:
 *   NODE_OPTIONS=--max-old-space-size=4096 pnpm make:fixture -- \
 *     --source data/snapshots/2026-06-12-vps \
 *     --out    data/snapshots/fixtures/2026-06-12-real-top5 \
 *     --top    5
 *     --trim-scope historical   # default for VPS rollouts: trim parquet/1m only, keep all paper ops
 *     --trim-scope all          # legacy demo: trim ops + historical to top-N symbols
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { scanText } from '../src/safety/secret-scan.js';
import type { SnapshotManifest } from '../src/contract/snapshot/manifest.js';

interface RawHistorical {
  barsBySymbolAndTimeframe: Record<string, Record<string, unknown[]>>;
  fundingBySymbol: Record<string, unknown[]>;
  openInterestBySymbol: Record<string, unknown[]>;
  liquidationsBySymbol: Record<string, unknown[]>;
  rowsBySymbol?: Record<string, unknown[]>;
}
interface RawBundle {
  runs: Array<{ id?: string; runId?: string }>;
  tradesByRun: Record<string, Array<{ symbol: string }>>;
  eventsByRun: Record<string, unknown[]>;
  decisionsByRun: Record<string, unknown[]>;
  analysisByRun: Record<string, unknown>;
  researchByRun: Record<string, unknown>;
  runtimeHealth: unknown;
  marketHealth: unknown;
  executionHealth: unknown;
  coverage: unknown;
  replay: unknown;
  historical?: RawHistorical;
  [k: string]: unknown;
}

/**
 * Wider input type: accepts deep-readonly / `as const` objects in addition to
 * plain mutable ones.  The generic parameter B captures the caller's concrete
 * shape so that when the caller passes a structuredClone'd `as const` literal
 * (which has explicit named keys on tradesByRun, not an index signature) the
 * return type preserves those explicit keys — avoiding the `| undefined` widening
 * that noUncheckedIndexedAccess applies to plain Record index signatures.
 */
type BundleLike = {
  readonly runs: ReadonlyArray<{ readonly id?: string; readonly runId?: string }>;
  readonly tradesByRun: { readonly [k: string]: ReadonlyArray<{ readonly symbol: string }> };
  readonly eventsByRun: { readonly [k: string]: ReadonlyArray<unknown> };
  readonly decisionsByRun: { readonly [k: string]: ReadonlyArray<unknown> };
  readonly analysisByRun: { readonly [k: string]: unknown };
  readonly researchByRun: { readonly [k: string]: unknown };
  readonly runtimeHealth: unknown;
  readonly marketHealth: unknown;
  readonly executionHealth: unknown;
  readonly coverage: unknown;
  readonly replay: unknown;
  readonly historical?: {
    readonly barsBySymbolAndTimeframe: { readonly [k: string]: { readonly [tf: string]: ReadonlyArray<unknown> } };
    readonly fundingBySymbol: { readonly [k: string]: ReadonlyArray<unknown> };
    readonly openInterestBySymbol: { readonly [k: string]: ReadonlyArray<unknown> };
    readonly liquidationsBySymbol: { readonly [k: string]: ReadonlyArray<unknown> };
    readonly rowsBySymbol?: { readonly [k: string]: ReadonlyArray<unknown> };
  };
  readonly [k: string]: unknown;
};

export function selectTopSymbols(bundle: BundleLike, n: number): string[] {
  const counts = new Map<string, number>();
  for (const trades of Object.values(bundle.tradesByRun)) {
    for (const t of trades) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([sym]) => sym);
}

const runIdOf = (r: { readonly id?: string; readonly runId?: string }): string =>
  r.id ?? r.runId ?? '';

const pickKeys = <V>(obj: { readonly [k: string]: V }, keep: Set<string>): Record<string, V> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k)));

const pickSyms = <V>(obj: { readonly [k: string]: V }, syms: Set<string>): Record<string, V> =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => syms.has(k)));

function filterHistoricalMaps(
  h: NonNullable<BundleLike['historical']>,
  symbols: string[],
): RawHistorical {
  const syms = new Set(symbols);
  return {
    barsBySymbolAndTimeframe: pickSyms(
      Object.fromEntries(
        Object.entries(h.barsBySymbolAndTimeframe).map(([sym, tfs]) => [
          sym,
          Object.fromEntries(Object.entries(tfs).map(([tf, bars]) => [tf, [...bars]])),
        ]),
      ),
      syms,
    ),
    fundingBySymbol: pickSyms(
      Object.fromEntries(Object.entries(h.fundingBySymbol).map(([k, v]) => [k, [...v]])),
      syms,
    ),
    openInterestBySymbol: pickSyms(
      Object.fromEntries(Object.entries(h.openInterestBySymbol).map(([k, v]) => [k, [...v]])),
      syms,
    ),
    liquidationsBySymbol: pickSyms(
      Object.fromEntries(Object.entries(h.liquidationsBySymbol).map(([k, v]) => [k, [...v]])),
      syms,
    ),
    ...(h.rowsBySymbol
      ? {
          rowsBySymbol: pickSyms(
            Object.fromEntries(Object.entries(h.rowsBySymbol).map(([k, v]) => [k, [...v]])),
            syms,
          ),
        }
      : {}),
  };
}

/** Trim only historical maps; preserve full paper/live ops (runs, trades, evidence). */
export function filterHistoricalToSymbols<B extends BundleLike>(bundle: B, symbols: string[]): B {
  if (!bundle.historical) return bundle;
  return {
    ...bundle,
    historical: filterHistoricalMaps(bundle.historical, symbols),
  } as unknown as B;
}

const tradeIdsFrom = (
  tradesByRun: Record<string, ReadonlyArray<{ tradeId?: string }>>,
): Set<string> =>
  new Set(
    Object.values(tradesByRun)
      .flat()
      .map((t) => t.tradeId)
      .filter((id): id is string => Boolean(id)),
  );

/**
 * Generic over B so the return type mirrors the caller's concrete bundle shape.
 * When called with a structuredClone of an `as const` literal, B has explicit
 * named keys on tradesByRun (not just an index signature), so
 * noUncheckedIndexedAccess does not widen member access to `T | undefined`.
 */
export function filterBundleToSymbols<B extends BundleLike>(bundle: B, symbols: string[]): B {
  const syms = new Set(symbols);

  const tradesByRun: Record<string, Array<{ symbol: string }>> = {};
  for (const [rid, trades] of Object.entries(bundle.tradesByRun)) {
    const kept = [...trades].filter((t) => syms.has(t.symbol));
    if (kept.length > 0) tradesByRun[rid] = kept;
  }
  const retained = new Set(Object.keys(tradesByRun));

  const h = bundle.historical;
  const historical = h ? filterHistoricalMaps(h, symbols) : undefined;

  const tradeEvidenceRaw = bundle.tradeEvidenceByTrade as Record<string, unknown> | undefined;
  const keptTradeIds = tradeIdsFrom(
    tradesByRun as Record<string, ReadonlyArray<{ tradeId?: string }>>,
  );
  const tradeEvidenceByTrade = tradeEvidenceRaw
    ? Object.fromEntries(Object.entries(tradeEvidenceRaw).filter(([id]) => keptTradeIds.has(id)))
    : undefined;

  return {
    ...bundle,
    runs: [...bundle.runs].filter((r) => retained.has(runIdOf(r))),
    tradesByRun,
    eventsByRun: pickKeys(bundle.eventsByRun, retained),
    decisionsByRun: pickKeys(bundle.decisionsByRun, retained),
    analysisByRun: pickKeys(bundle.analysisByRun, retained),
    researchByRun: pickKeys(bundle.researchByRun, retained),
    ...(tradeEvidenceByTrade !== undefined ? { tradeEvidenceByTrade } : {}),
    ...(historical !== undefined ? { historical } : {}),
  } as unknown as B;
}

/**
 * Normalizes the historical sub-bundle so it conforms to the contract schema,
 * bridging field-name differences between fetch-snapshot's internal OIEntry /
 * liquidation shapes and the published OpenInterestEntry / LiquidationEntry
 * contract shapes.
 *
 * - openInterest: renames `oiUsd` → `openInterestUsd` (fetch-snapshot used a
 *   shorter alias; the contract always required the full name).
 * - liquidations: fetch-snapshot stores per-minute combined rows
 *   `{ tsMs, symbol, longUsd, shortUsd }`.  The contract requires two separate
 *   rows per minute: `{ tsMs, symbol, side: 'long'|'short', sizeUsd }`.
 *   This function expands each combined row into two canonical rows.
 *
 * Called only in main() after filtering, before secret-scan and write.
 * Not exported; does not affect filterBundleToSymbols or test behaviour.
 */
function normalizeHistorical(h: RawHistorical): RawHistorical {
  // 1. openInterest: oiUsd → openInterestUsd
  const openInterestBySymbol: Record<string, unknown[]> = {};
  for (const [sym, entries] of Object.entries(h.openInterestBySymbol)) {
    openInterestBySymbol[sym] = entries.map((e) => {
      const rec = e as Record<string, unknown>;
      if ('oiUsd' in rec && !('openInterestUsd' in rec)) {
        const { oiUsd, ...rest } = rec;
        return { ...rest, openInterestUsd: oiUsd };
      }
      return rec;
    });
  }

  // 2. liquidations: { longUsd, shortUsd } → two side rows per minute
  const liquidationsBySymbol: Record<string, unknown[]> = {};
  for (const [sym, entries] of Object.entries(h.liquidationsBySymbol)) {
    const expanded: unknown[] = [];
    for (const e of entries) {
      const rec = e as Record<string, unknown>;
      if ('longUsd' in rec || 'shortUsd' in rec) {
        const { longUsd, shortUsd, ...base } = rec;
        const longSize = typeof longUsd === 'number' ? longUsd : 0;
        const shortSize = typeof shortUsd === 'number' ? shortUsd : 0;
        if (longSize > 0) expanded.push({ ...base, side: 'long', sizeUsd: longSize });
        if (shortSize > 0) expanded.push({ ...base, side: 'short', sizeUsd: shortSize });
        // a minute with no liquidations on either side contributes no rows
      } else {
        expanded.push(rec);
      }
    }
    liquidationsBySymbol[sym] = expanded;
  }

  return { ...h, openInterestBySymbol, liquidationsBySymbol };
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function argMaybe(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function main(): void {
  const source = arg('source');
  const out = arg('out');
  const topN = Number(arg('top', '5'));
  const trimScope = argMaybe('trim-scope') ?? 'historical';

  const srcManifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as {
    versions: Record<string, string>;
  };
  const srcBundle = JSON.parse(readFileSync(join(source, 'ops', 'bundle.json'), 'utf8')) as RawBundle;

  const symbols = selectTopSymbols(srcBundle, topN);
  const filtered =
    trimScope === 'all'
      ? filterBundleToSymbols(srcBundle, symbols)
      : filterHistoricalToSymbols(srcBundle, symbols);
  const fixture: RawBundle = filtered.historical
    ? { ...filtered, historical: normalizeHistorical(filtered.historical) }
    : filtered;
  const bundleStr = JSON.stringify(fixture);

  const hits = scanText(bundleStr);
  if (hits.length > 0) {
    throw new Error(`secret-scan tripped on fixture bundle: ${hits.join(', ')} — narrow symbols or redact source`);
  }

  const ref = out.split('/').filter(Boolean).slice(-1)[0];
  if (!ref) throw new Error(`could not derive a snapshot ref from --out '${out}'`);
  const manifest: SnapshotManifest = {
    ref,
    createdAtMs: Date.now(),
    versions: { ...srcManifest.versions, exporterVersion: 'fixture-trim.1' } as SnapshotManifest['versions'],
    bundleRef: 'ops/bundle.json',
    checksumsRef: 'checksums.json',
  };

  mkdirSync(join(out, 'ops'), { recursive: true });
  writeFileSync(join(out, 'ops', 'bundle.json'), bundleStr);
  writeFileSync(join(out, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  loadSnapshot(out);

  const tradeCount = Object.values(fixture.tradesByRun).reduce((s, a) => s + a.length, 0);
  const evidenceCount = Object.keys(
    (fixture.tradeEvidenceByTrade as Record<string, unknown> | undefined) ?? {},
  ).length;
  const scopeNote = trimScope === 'all' ? 'ops+historical trimmed' : 'historical trimmed, full paper ops kept';
  console.log(
    `fixture '${ref}' written (${scopeNote}): ${symbols.length} hist symbols [${symbols.join(', ')}], ${tradeCount} trades, ${evidenceCount} trade evidence, ${fixture.runs.length} run(s)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
