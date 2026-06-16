import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import { readRuntimeHealth, readMarketHealth, readExecutionHealth } from '../../snapshot/readers/health.js';

export const handleRuntimeHealth = (b: SnapshotBundle) => readRuntimeHealth(b);
export const handleMarketHealth = (b: SnapshotBundle) => readMarketHealth(b);
export const handleExecutionHealth = (b: SnapshotBundle) => readExecutionHealth(b);
