import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { ResearchRunResult } from '../../contract/research-read/dto.js';

export function readResearchResult(b: SnapshotBundle, runId: string): ResearchRunResult | undefined {
  return b.researchByRun[runId];
}
export function listResearchResults(b: SnapshotBundle): readonly ResearchRunResult[] {
  return Object.values(b.researchByRun);
}
