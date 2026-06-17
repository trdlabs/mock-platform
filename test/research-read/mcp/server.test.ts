import { describe, it, expect, vi } from 'vitest';
import { dispatchTool, type ToolCtx } from '../../../src/research-read/mcp/server.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';

const bundle = {
  runs: [{ runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' },
    startedAtMs: 100, finishedAtMs: 900, lastSeenMs: 900, symbols: ['ETHUSDT'] }],
  researchByRun: { r1: { summary: { runRef: 'r1', mode: 'paper',
    metrics: { netPnlUsd: '24.25', winRate: 50, maxDrawdownPct: '0.90', profitFactor: '2.33', sharpe: { available: false }, totalTrades: 2 },
    asOf: 900 }, trades: [], decisions: [], analysisContext: 'ok' } },
} as unknown as SnapshotBundle;

function parse(res: { content: Array<{ type: 'text'; text: string }> }): unknown {
  return JSON.parse(res.content.map((c) => c.text).join(''));
}

describe('dispatchTool', () => {
  const audit = vi.fn();
  const ctx: ToolCtx = { bundle, audit };

  it('discover_research_contract → 017.2 descriptor (audited accepted)', () => {
    const r = parse(dispatchTool('discover_research_contract', {}, ctx)) as { contractVersion: string };
    expect(r.contractVersion).toBe('017.2');
    expect(audit).toHaveBeenCalledWith('discover_research_contract', 'accepted');
  });
  it('get_run_result reads runId from args', () => {
    const r = parse(dispatchTool('get_run_result', { runId: 'r1' }, ctx)) as { ok: boolean; summary?: { metrics: Record<string, number> } };
    expect(r.ok).toBe(true);
    expect(r.summary!.metrics.pnl).toBeCloseTo(24.25);
  });
  it.each(['validate_module', 'submit_run', 'cancel_run', 'read_artifact'])('%s → backtest-unavailable (audited rejected)', (name) => {
    const r = parse(dispatchTool(name, {}, ctx)) as { ok: boolean; error: { message: string } };
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe('backtesting_moved_to_trading_backtester');
    expect(audit).toHaveBeenCalledWith(name, 'rejected');
  });
  it('unknown tool → validation error envelope (never throws)', () => {
    const r = parse(dispatchTool('nope', {}, ctx)) as { ok: boolean; error: { category: string } };
    expect(r.ok).toBe(false);
    expect(r.error.category).toBe('validation_error');
  });
});
