import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../contract/historical-read/dto.js';
import { synthesizeRowsFromPerKind } from './rows-from-perkind.js';

export interface RowsFilter {
  readonly symbol?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
}

export function readRows(bundle: SnapshotBundle, f: RowsFilter): readonly CanonicalRowV2[] {
  if (f.symbol === undefined) return [];
  const hist = bundle.historical;
  if (hist === undefined) return [];
  // historical.2 reads rowsBySymbol; pre-rows snapshots (per-kind only) are synthesized on the fly.
  const rows = hist.rowsBySymbol?.[f.symbol] ?? synthesizeRowsFromPerKind(hist, f.symbol);
  // Range is HALF-OPEN [fromMs, toMs) — platform parity
  // (storage/historical/reader/query_filters: ts < from || ts >= to → skip). An inclusive
  // upper bound double-counts the boundary bar across adjacent walk-forward folds.
  return rows.filter((r) =>
    (f.fromMs === undefined || r.minute_ts >= f.fromMs) &&
    (f.toMs === undefined || r.minute_ts < f.toMs),
  );
}
