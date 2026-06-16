import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { ClosedTrade } from '../../contract/ops-read/dto.js';

export function readTrades(bundle: SnapshotBundle, runId: string): readonly ClosedTrade[] {
  return bundle.tradesByRun[runId] ?? [];
}
