import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RowsPage, CanonicalRowV2 } from '../../contract/historical-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readRows, isKnownHistoricalSymbol, isCoarseOnlySymbol } from '../../snapshot/readers/rows.js';
import { hasMinuteGrainBars } from '../../snapshot/readers/rows-from-perkind.js';
import { paginate, invalidCursor } from '../../ops/pagination.js';

function unavailable(): OpsError {
  return { category: 'not_found', code: 'historical_unavailable', message: 'historical data not present in this snapshot' };
}

/** No minute-grain source to serve from — see the P1-2 note in readRows. Distinct code from
 *  `historical_unavailable`: the snapshot HAS historical data, just not at minute grain. The
 *  coarser bars stay in the snapshot and are described, with their own timeframe, by
 *  /historical/coverage and /historical/discover — there is no /historical/bars endpoint. */
function noMinuteGrain(symbols?: readonly string[]): OpsError {
  const scope = symbols !== undefined && symbols.length > 0
    ? `the requested symbol(s) ${[...symbols].sort().join(', ')} carry only coarser-than-minute bars`
    : 'this snapshot carries no minute-grain data';
  return {
    category: 'not_found',
    code: 'minute_rows_unavailable',
    message: `${scope}; /historical/rows serves minute rows only. `
      + 'The bars themselves remain in the snapshot — see /historical/coverage, which states their timeframe.',
  };
}

export function handleRows(
  bundle: SnapshotBundle,
  params: { symbols?: readonly string[]; fromMs?: number; toMs?: number; limit?: number },
  asOf: number,
  cursor?: string,
): RowsPage | OpsError {
  if (!bundle.historical) return unavailable();

  const hist = bundle.historical;
  const { fromMs, toMs, limit } = params;
  const symbols = params.symbols ?? [];

  // The symbol list is de-duplicated first: platform resolves the request through a Set, so
  // `symbols=BTC,BTC` selects one symbol rather than emitting each row twice. Without this the
  // duplicated rows also break the strict global order below, since two rows can then share
  // both minute_ts and symbol.
  const requested = [...new Set(symbols)];

  // Fail loudly rather than serving an empty page when nothing in scope can back minute rows:
  // an empty page is indistinguishable from "your window matched nothing", which is exactly the
  // silent divergence this guard exists to remove (audit P1-2).
  //
  // The check is scoped to the REQUEST, not the snapshot: a mixed snapshot may hold native
  // minute rows for one symbol and only 1h bars for another, and asking for just the latter
  // must fail rather than look like an empty window. A request naming at least one
  // minute-capable symbol is served; coarse-only symbols in it simply contribute nothing.
  const known = requested.filter((s) => isKnownHistoricalSymbol(hist, s));
  if (known.length > 0) {
    if (known.every((s) => isCoarseOnlySymbol(hist, s))) return noMinuteGrain(known);
  } else {
    // Nothing requested resolves to a symbol in this snapshot (unknown symbols, or no symbols
    // at all). Unknown symbols must stay a graceful empty page whenever the resource itself is
    // available, so fall back to the snapshot-wide question discover answers.
    const minuteGrainAvailable = Object.values(hist.rowsBySymbol ?? {}).some((r) => r.length > 0)
      || Object.keys(hist.barsBySymbolAndTimeframe ?? {}).some((s) => hasMinuteGrainBars(hist, s));
    if (!minuteGrainAvailable) return noMinuteGrain();
  }

  // Gather rows for every requested symbol. Unknown symbols contribute nothing
  // (readRows returns []) — no match yields an empty page.
  const rows: CanonicalRowV2[] = [];
  for (const symbol of requested) {
    rows.push(...readRows(bundle, {
      symbol,
      ...(fromMs !== undefined ? { fromMs } : {}),
      ...(toMs !== undefined ? { toMs } : {}),
    }));
  }

  // A multi-symbol response is one globally ordered stream — (minute_ts ASC, symbol ASC) —
  // not a per-symbol concatenation echoing the caller's symbol order (control-center audit
  // P1-1; platform storage/historical/http/historical-http-app). Sorting happens BEFORE
  // pagination so the order is a property of the whole result set, not of a single page.
  rows.sort((a, b) =>
    a.minute_ts - b.minute_ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );

  try {
    return paginate(rows, cursor, limit, {
      asOf,
      window: {
        ...(fromMs !== undefined ? { fromMs } : {}),
        ...(toMs !== undefined ? { toMs } : {}),
      },
    });
  } catch {
    return invalidCursor();
  }
}
