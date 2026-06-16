import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { DecisionsPage } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readDecisions } from '../../snapshot/readers/decisions.js';
import { paginate, invalidCursor } from '../pagination.js';

export function handleDecisions(bundle: SnapshotBundle, runId: string, asOf: number, cursor?: string): DecisionsPage | OpsError {
  try { return paginate(readDecisions(bundle, runId), cursor, undefined, { asOf }); }
  catch { return invalidCursor(); }
}
