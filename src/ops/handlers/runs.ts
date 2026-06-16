import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RunsPage } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readRuns, type RunsFilter } from '../../snapshot/readers/runs.js';
import { paginate, invalidCursor } from '../pagination.js';

export function handleRuns(bundle: SnapshotBundle, filter: RunsFilter, asOf: number, cursor?: string): RunsPage | OpsError {
  try { return paginate(readRuns(bundle, filter), cursor, undefined, { asOf }); }
  catch { return invalidCursor(); }
}
