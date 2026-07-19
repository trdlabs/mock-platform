import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RowsPage, CanonicalRowV2 } from '../../contract/historical-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readRows } from '../../snapshot/readers/rows.js';
import { paginate, invalidCursor } from '../../ops/pagination.js';

function unavailable(): OpsError {
  return { category: 'not_found', code: 'historical_unavailable', message: 'historical data not present in this snapshot' };
}

export function handleRows(
  bundle: SnapshotBundle,
  params: { symbols?: readonly string[]; fromMs?: number; toMs?: number; limit?: number },
  asOf: number,
  cursor?: string,
): RowsPage | OpsError {
  if (!bundle.historical) return unavailable();

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
