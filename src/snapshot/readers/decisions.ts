import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { DecisionLogEntry } from '../../contract/ops-read/dto.js';

export function readDecisions(bundle: SnapshotBundle, runId: string): readonly DecisionLogEntry[] {
  return bundle.decisionsByRun[runId] ?? [];
}
