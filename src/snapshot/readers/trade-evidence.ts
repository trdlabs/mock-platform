import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { TradeEvidence } from '../../contract/ops-read/dto.js';

/** Батч-выборка per-trade evidence из бандла; порядок = порядок запроса, отсутствующие опускаются. */
export function readTradeEvidence(
  bundle: SnapshotBundle,
  tradeIds: readonly string[],
): readonly TradeEvidence[] {
  const out: TradeEvidence[] = [];
  for (const id of tradeIds) {
    const ev = bundle.tradeEvidenceByTrade[id];
    if (ev) out.push(ev);
  }
  return out;
}
