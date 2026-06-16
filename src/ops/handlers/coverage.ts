import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import { readCoverage } from '../../snapshot/readers/coverage.js';

export function handleCoverage(b: SnapshotBundle, source?: string, kind?: string) {
  return readCoverage(b, source, kind);
}
