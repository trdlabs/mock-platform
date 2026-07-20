import type { SnapshotBundle, HistoricalBundle } from '../../contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../contract/historical-read/dto.js';
import {
  synthesizeRowsFromPerKind,
  hasMinuteGrainBars,
  syntheticRowGrainMs,
  MINUTE_MS,
} from './rows-from-perkind.js';

export interface RowsFilter {
  readonly symbol?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
}

/** Whether the snapshot carries anything at all for `symbol` (rows or bars). */
export function isKnownHistoricalSymbol(hist: HistoricalBundle, symbol: string): boolean {
  return hist.rowsBySymbol?.[symbol] !== undefined
    || hist.barsBySymbolAndTimeframe?.[symbol] !== undefined;
}

/**
 * Whether serving `symbol` would mean projecting coarser-than-minute bars into `minute_ts`.
 *
 * Per-symbol, not per-snapshot: a mixed snapshot can hold native minute rows for one symbol
 * and only 1h bars for another, and a request naming just the latter must not come back as a
 * plausible-looking empty page (control-center audit P1-2).
 */
export function isCoarseOnlySymbol(hist: HistoricalBundle, symbol: string): boolean {
  // A native rowsBySymbol entry is minute-grain by contract, even when it is empty for the
  // requested window — that is a genuine empty result, not a grain mismatch.
  if (hist.rowsBySymbol?.[symbol] !== undefined) return false;
  const grain = syntheticRowGrainMs(hist, symbol);
  return grain !== undefined && grain !== MINUTE_MS;
}

export function readRows(bundle: SnapshotBundle, f: RowsFilter): readonly CanonicalRowV2[] {
  if (f.symbol === undefined) return [];
  const hist = bundle.historical;
  if (hist === undefined) return [];
  // historical.2 reads rowsBySymbol; pre-rows snapshots (per-kind only) are synthesized on the fly —
  // but ONLY from minute-grain bars. Synthesizing from 1h/1d bars yields rows whose minute_ts steps
  // by the bar interval, indistinguishable to a consumer from real minute data: a backtest over them
  // is silently wrong (control-center audit P1-2). A coarser-than-minute source serves nothing here;
  // the bars stay available through the bars-keyed endpoints, which describe their own timeframe.
  const rows = hist.rowsBySymbol?.[f.symbol]
    ?? (hasMinuteGrainBars(hist, f.symbol) ? synthesizeRowsFromPerKind(hist, f.symbol) : []);
  // Range is HALF-OPEN [fromMs, toMs) — platform parity
  // (storage/historical/reader/query_filters: ts < from || ts >= to → skip). An inclusive
  // upper bound double-counts the boundary bar across adjacent walk-forward folds.
  return rows.filter((r) =>
    (f.fromMs === undefined || r.minute_ts >= f.fromMs) &&
    (f.toMs === undefined || r.minute_ts < f.toMs),
  );
}
