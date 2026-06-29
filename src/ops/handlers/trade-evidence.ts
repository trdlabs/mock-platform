import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { TradeEvidencePage } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readTradeEvidence } from '../../snapshot/readers/trade-evidence.js';

/** Жёсткий потолок батча (Surface A) — защита от неограниченного fan-out. */
const MAX_TRADE_IDS = 25;

export function handleTradeEvidence(
  bundle: SnapshotBundle,
  tradeIdsCsv: string,
  asOf: number,
): TradeEvidencePage | OpsError {
  const ids = tradeIdsCsv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (ids.length === 0) {
    return { category: 'validation_error', code: 'missing_trade_ids', message: 'tradeIds is required (comma-separated, <=25)' };
  }
  if (ids.length > MAX_TRADE_IDS) {
    return { category: 'validation_error', code: 'too_many_trade_ids', message: `at most ${MAX_TRADE_IDS} tradeIds per request` };
  }
  // Батч-by-id: single-page envelope, nextCursor null (НЕ курсорная пагинация).
  return { items: readTradeEvidence(bundle, ids), nextCursor: null, asOf, window: {}, freshness: 'fresh' };
}
