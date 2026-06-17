import { describe, it, expect } from 'vitest';
import { discoverDescriptor, listDatasets, runStatus, runResult } from '../../../src/research-read/mcp/projections.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [
    { runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' },
      startedAtMs: 100, finishedAtMs: 900, lastSeenMs: 900, symbols: ['ETHUSDT'] },
    { runId: 'r2', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: ['BTCUSDT'] },
    { runId: 'r3', mode: 'live', status: 'weird', strategy: { name: 's', version: '1' },
      startedAtMs: 5, finishedAtMs: null, lastSeenMs: 6, symbols: ['BTCUSDT'] },
  ],
  researchByRun: {
    r1: { summary: { runRef: 'r1', mode: 'paper',
      metrics: { netPnlUsd: '24.25', winRate: 50, maxDrawdownPct: '0.90', profitFactor: '2.33', sharpe: { available: false }, totalTrades: 2 },
      asOf: 900 }, trades: [], decisions: [], analysisContext: 'ok' },
  },
} as unknown as SnapshotBundle;

describe('projections', () => {
  it('discover returns contract 017.2 with a supportedContractVersions array', () => {
    const d = discoverDescriptor();
    expect(d.contractVersion).toBe('017.2');
    expect(d.supportedContractVersions).toContain('017.2');
    expect(Array.isArray(d.marketDataKinds)).toBe(true);
    expect(d.metricCatalog).toContain('pnl');
  });
  it('list_datasets is valid-empty (datasets array present, empty)', () => {
    expect(listDatasets()).toEqual({ datasets: [] });
  });
  it('runStatus maps a finished run to completed (terminal)', () => {
    const r = runStatus(bundle, 'r1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.status).toBe('completed');
    expect(r.view.runId).toBe('r1');
    expect(r.view.timeline.acceptedAtMs).toBe(100);
  });
  it('runStatus maps a running run to running', () => {
    const r = runStatus(bundle, 'r2');
    expect(r.ok && r.view.status).toBe('running');
  });
  it('runStatus returns an error envelope for an unknown run (no throw)', () => {
    const r = runStatus(bundle, 'rX');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.category).toBe('validation_error');
  });
  it('runResult projects metrics capability-aware (sharpe omitted; required arrays present)', () => {
    const r = runResult(bundle, 'r1');
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'summary') return;
    expect(r.summary.metrics.pnl).toBeCloseTo(24.25);
    expect(r.summary.metrics.win_rate).toBe(50);
    expect(r.summary.metrics.profit_factor).toBeCloseTo(2.33);
    expect('sharpe' in r.summary.metrics).toBe(false);             // {available:false} → omitted, not fabricated
    expect(r.summary.validationIssues).toEqual([]);                // required array present
    expect(r.summary.coverage).toEqual([]);
    expect(r.summary.artifactRefs).toEqual([]);
    expect(r.summary.comparison).toBeUndefined();                  // optional → omitted
    expect(r.summary.evidence.contractVersion).toBe('017.2');
  });
  it('runResult returns an error envelope for an unknown run', () => {
    const r = runResult(bundle, 'rX');
    expect(r.ok).toBe(false);
  });
  it('runResult on a non-terminal (running) run returns the status arm, NOT a fabricated summary', () => {
    const r = runResult(bundle, 'r2');
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'status') return;
    expect(r.view.status).toBe('running');
  });
  it('an unexpected run status never silently becomes completed — it errors (unmappable_status)', () => {
    const s = runStatus(bundle, 'r3');
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.error.code).toBe('unmappable_status');
    expect(runResult(bundle, 'r3').ok).toBe(false);
  });
});
