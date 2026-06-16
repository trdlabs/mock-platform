import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { AnalysisSnapshot } from '../../contract/analysis/dto.js';

export function readAnalysis(b: SnapshotBundle, runId: string): AnalysisSnapshot | undefined {
  return b.analysisByRun[runId];
}
