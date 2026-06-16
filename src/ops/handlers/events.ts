import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { EventsPage } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readEvents } from '../../snapshot/readers/events.js';
import { paginate, invalidCursor } from '../pagination.js';

export function handleEvents(bundle: SnapshotBundle, runId: string, asOf: number, cursor?: string): EventsPage | OpsError {
  try { return paginate(readEvents(bundle, runId), cursor, undefined, { asOf }); }
  catch { return invalidCursor(); }
}
