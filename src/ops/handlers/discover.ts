import type { OpsCapabilityDescriptor, OpsResourceDescriptor } from '../../contract/ops-read/dto.js';
import { OPS_CAPABILITIES } from '../../contract/common/capabilities.js';
import { OPS_READ_CONTRACT_VERSION } from '../../contract/ops-read/version.js';
import { MAX_PAGE } from '../pagination.js';

const RESOURCES: readonly OpsResourceDescriptor[] = [
  { name: 'runs', supportedFilters: ['status', 'mode', 'symbol', 'cursor'],
    pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['runId', 'mode', 'status', 'strategy', 'startedAtMs', 'finishedAtMs', 'lastSeenMs', 'symbols'] },
  // mock hardcodes excludesReconcile:true (no reconcile data to toggle), so it advertises no filters.
  { name: 'summary', supportedFilters: [], pagination: null, fields: ['runId', 'closedTrades', 'winratePct', 'pnlUsd'] },
  { name: 'trades', supportedFilters: ['runId', 'cursor'], pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['tradeId', 'runId', 'symbol', 'side', 'realizedPnl'] },
  { name: 'events', supportedFilters: ['runId', 'cursor'], pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['category', 'severity', 'runId', 'tsMs', 'safeMessage'] },
  { name: 'decisions', supportedFilters: ['runId', 'cursor'], pagination: { cursor: true, maxPageItems: MAX_PAGE }, fields: ['category', 'runId', 'symbol', 'reason', 'tsMs'] },
  { name: 'runtime-health', supportedFilters: [], pagination: null, fields: ['entries', 'asOf'], availability: 'available' },
  { name: 'market-health', supportedFilters: [], pagination: null, fields: ['status', 'availability', 'asOf'], availability: 'available' },
  { name: 'execution-health', supportedFilters: [], pagination: null, fields: ['status', 'availability', 'asOf'], availability: 'available' },
  { name: 'source-coverage', supportedFilters: ['source', 'kind'], pagination: null, fields: ['entries', 'availability', 'asOf'], availability: 'available' },
  { name: 'run-analysis', supportedFilters: [], pagination: null, fields: ['runRef', 'metrics', 'trades'] },
  { name: 'trade-evidence', supportedFilters: ['tradeIds'], pagination: null,
    fields: ['tradeId', 'runId', 'symbol', 'side', 'entryPrice', 'exitPrice', 'realizedPnl', 'pnlPct', 'closeReason', 'lifecycle'] },
];

export function buildDiscover(): OpsCapabilityDescriptor {
  return {
    opsContractVersion: OPS_READ_CONTRACT_VERSION,
    capabilities: OPS_CAPABILITIES,
    resources: RESOURCES,
  };
}
