import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { BotRunRecord } from '../../contract/ops-read/dto.js';

export interface RunsFilter { mode?: string; status?: string; symbol?: string; }

export function readRuns(bundle: SnapshotBundle, f: RunsFilter): readonly BotRunRecord[] {
  return bundle.runs.filter((r) =>
    (f.mode ? r.mode === f.mode : true) &&
    (f.status ? r.status === f.status : true) &&
    (f.symbol ? r.symbols.includes(f.symbol) : true),
  );
}
