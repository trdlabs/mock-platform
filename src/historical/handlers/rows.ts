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

  // Concatenate rows per requested symbol, in request order. Unknown symbols
  // contribute nothing (readRows returns []) — no match yields an empty page.
  const rows: CanonicalRowV2[] = [];
  for (const symbol of symbols) {
    rows.push(...readRows(bundle, {
      symbol,
      ...(fromMs !== undefined ? { fromMs } : {}),
      ...(toMs !== undefined ? { toMs } : {}),
    }));
  }

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
