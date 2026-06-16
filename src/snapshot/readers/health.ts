import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type {
  RuntimeHealthCollection, MarketServiceHealthSnapshot, ExecutionHealthSnapshot,
} from '../../contract/ops-read/dto.js';

export const readRuntimeHealth = (b: SnapshotBundle): RuntimeHealthCollection => b.runtimeHealth;
export const readMarketHealth = (b: SnapshotBundle): MarketServiceHealthSnapshot => b.marketHealth;
export const readExecutionHealth = (b: SnapshotBundle): ExecutionHealthSnapshot => b.executionHealth;
