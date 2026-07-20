import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RowsPage, CanonicalRowV2 } from '../../contract/historical-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readRows } from '../../snapshot/readers/rows.js';
import { hasMinuteGrainBars } from '../../snapshot/readers/rows-from-perkind.js';
import { paginate, invalidCursor } from '../../ops/pagination.js';

function unavailable(): OpsError {
  return { category: 'not_found', code: 'historical_unavailable', message: 'historical data not present in this snapshot' };
}

/** No minute-grain source anywhere in the snapshot — see the P1-2 note in readRows. Distinct
 *  code from `historical_unavailable`: the snapshot HAS historical data, just not at minute
 *  grain, and the bars remain reachable through the bars-keyed endpoints. */
function noMinuteGrain(): OpsError {
  return {
    category: 'not_found',
    code: 'minute_rows_unavailable',
    message: 'this snapshot carries no minute-grain data; /historical/rows is unavailable '
      + '(coarser bars are served by the bars endpoints, which state their own timeframe)',
  };
}

export function handleRows(
  bundle: SnapshotBundle,
  params: { symbols?: readonly string[]; fromMs?: number; toMs?: number; limit?: number },
  asOf: number,
  cursor?: string,
): RowsPage | OpsError {
  if (!bundle.historical) return unavailable();

  // Fail loudly rather than serving an empty page: on a bars-only 1h/1d snapshot an empty
  // page is indistinguishable from "your window matched nothing", which is exactly the
  // silent-divergence this guard exists to remove. discover marks the resource unavailable
  // in the same case, so the two surfaces agree.
  const hist = bundle.historical;
  const minuteGrainAvailable = Object.values(hist.rowsBySymbol ?? {}).some((r) => r.length > 0)
    || Object.keys(hist.barsBySymbolAndTimeframe ?? {}).some((s) => hasMinuteGrainBars(hist, s));
  if (!minuteGrainAvailable) return noMinuteGrain();

  const { fromMs, toMs, limit } = params;
  const symbols = params.symbols ?? [];

  // Gather rows for every requested symbol. Unknown symbols contribute nothing
  // (readRows returns []) — no match yields an empty page.
  //
  // The symbol list is de-duplicated first: platform resolves the request through a Set,
  // so `symbols=BTC,BTC` selects one symbol rather than emitting each row twice. Without
  // this the duplicated rows also break the strict global order below, since two rows can
  // then share both minute_ts and symbol.
  const rows: CanonicalRowV2[] = [];
  for (const symbol of new Set(symbols)) {
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
