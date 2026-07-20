import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../contract/historical-read/dto.js';
import { synthesizeRowsFromPerKind, hasMinuteGrainBars } from './rows-from-perkind.js';

export interface RowsFilter {
  readonly symbol?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
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
