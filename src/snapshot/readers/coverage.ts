import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { SourceCoverageSnapshot } from '../../contract/ops-read/dto.js';

export function readCoverage(b: SnapshotBundle, source?: string, kind?: string): SourceCoverageSnapshot {
  if (!source && !kind) return b.coverage;
  return {
    ...b.coverage,
    entries: b.coverage.entries.filter((e) =>
      (source ? e.source === source : true) && (kind ? e.kind === kind : true)),
  };
}
