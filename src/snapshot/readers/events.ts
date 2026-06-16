import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { OperationalEvent } from '../../contract/ops-read/dto.js';

export function readEvents(bundle: SnapshotBundle, runId: string): readonly OperationalEvent[] {
  return bundle.eventsByRun[runId] ?? [];
}
