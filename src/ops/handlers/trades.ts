import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { TradesPage } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readTrades } from '../../snapshot/readers/trades.js';
import { paginate, invalidCursor } from '../pagination.js';

export function handleTrades(bundle: SnapshotBundle, runId: string, asOf: number, cursor?: string): TradesPage | OpsError {
  try { return paginate(readTrades(bundle, runId), cursor, undefined, { asOf }); }
  catch { return invalidCursor(); }
}
