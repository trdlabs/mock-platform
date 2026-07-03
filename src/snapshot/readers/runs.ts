import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { BotRunRecord } from '../../contract/ops-read/dto.js';

export interface RunsFilter { mode?: string; status?: string; symbol?: string; bundleId?: string; }

export function readRuns(bundle: SnapshotBundle, f: RunsFilter): readonly BotRunRecord[] {
  return bundle.runs
    // ops.6: снапшоты до bundleId нормализуются к null (поле обязательно в SDK-DTO).
    .map((r) => ({ ...r, bundleId: r.bundleId ?? null }))
    .filter((r) =>
      (f.mode ? r.mode === f.mode : true) &&
      (f.status ? r.status === f.status : true) &&
      (f.symbol ? r.symbols.includes(f.symbol) : true) &&
      (f.bundleId ? r.bundleId === f.bundleId : true),
    );
}
