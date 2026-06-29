import { describe, it, expect } from 'vitest';
import { mapEventType, toLifecycleEvent, buildTradeEvidenceByTrade } from '../../tools/fetch-snapshot/trade-evidence-map.js';

describe('mapEventType', () => {
  it('maps canonical event_type to ops lifecycle type', () => {
    expect(mapEventType('trade_opened')).toBe('entry');
    expect(mapEventType('trade_scaled_in')).toBe('dca');
    expect(mapEventType('tp1_armed')).toBe('tp');
    expect(mapEventType('tp_armed')).toBe('tp');
    expect(mapEventType('trade_closed')).toBe('exit');
    expect(mapEventType('weird')).toBeNull();
  });
});

describe('toLifecycleEvent', () => {
  it('uses trigger_price for tp (arm) events and fill_price otherwise', () => {
    const tp = toLifecycleEvent({ tradeId: 't', eventType: 'tp_armed', tsMs: 5, fillPrice: null, triggerPrice: '0.12', qty: null, reason: 'arm_breakeven' });
    expect(tp).toEqual({ tsMs: 5, type: 'tp', price: '0.12', qty: null, note: 'arm_breakeven' });
    const open = toLifecycleEvent({ tradeId: 't', eventType: 'trade_opened', tsMs: 1, fillPrice: '0.1', triggerPrice: null, qty: '5', reason: 'signal' });
    expect(open).toEqual({ tsMs: 1, type: 'entry', price: '0.1', qty: '5', note: 'signal' });
  });
  it('maps tp1_armed (v1 alias) to tp using trigger_price', () => {
    const out = toLifecycleEvent({ tradeId: 't', eventType: 'tp1_armed', tsMs: 7, fillPrice: null, triggerPrice: '0.2', qty: null, reason: 'arm' });
    expect(out).toEqual({ tsMs: 7, type: 'tp', price: '0.2', qty: null, note: 'arm' });
  });
  it('returns null for unknown event types', () => {
    expect(toLifecycleEvent({ tradeId: 't', eventType: 'noise', tsMs: 1, fillPrice: null, triggerPrice: null, qty: null, reason: null })).toBeNull();
  });
});

describe('buildTradeEvidenceByTrade', () => {
  it('groups lifecycle by trade in input order and skips unknown events', () => {
    const trades = [{ tradeId: 't1', runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long' as const,
      openedAtMs: 1, closedAtMs: 9, entryPrice: '0.1', exitPrice: '0.09', realizedPnl: '-1', pnlPct: '-10', closeReason: 'stop_loss' }];
    const life = [
      { tradeId: 't1', eventType: 'trade_opened', tsMs: 1, fillPrice: '0.1', triggerPrice: null, qty: '5', reason: 'signal' },
      { tradeId: 't1', eventType: 'noise', tsMs: 2, fillPrice: null, triggerPrice: null, qty: null, reason: null },
      { tradeId: 't1', eventType: 'trade_closed', tsMs: 9, fillPrice: '0.09', triggerPrice: null, qty: '5', reason: 'stop_loss' },
    ];
    const out = buildTradeEvidenceByTrade(trades, life);
    expect(Object.keys(out)).toEqual(['t1']);
    expect(out['t1']!.lifecycle.map((e) => e.type)).toEqual(['entry', 'exit']);
    expect(out['t1']!.entryPrice).toBe('0.1');
  });
  it('groups interleaved lifecycle rows by trade without cross-contamination', () => {
    const trades = [
      { tradeId: 't1', runId: 'r', symbol: 'A', side: 'long' as const, openedAtMs: 1, closedAtMs: 4, entryPrice: '1', exitPrice: '2', realizedPnl: '1', pnlPct: '1', closeReason: null },
      { tradeId: 't2', runId: 'r', symbol: 'B', side: 'short' as const, openedAtMs: 2, closedAtMs: 5, entryPrice: '3', exitPrice: '4', realizedPnl: '1', pnlPct: '1', closeReason: null },
    ];
    const life = [
      { tradeId: 't1', eventType: 'trade_opened', tsMs: 1, fillPrice: '1', triggerPrice: null, qty: '1', reason: null },
      { tradeId: 't2', eventType: 'trade_opened', tsMs: 2, fillPrice: '3', triggerPrice: null, qty: '1', reason: null },
      { tradeId: 't1', eventType: 'trade_closed', tsMs: 4, fillPrice: '2', triggerPrice: null, qty: '1', reason: null },
    ];
    const out = buildTradeEvidenceByTrade(trades, life);
    expect(out['t1']!.lifecycle.map((e) => e.type)).toEqual(['entry', 'exit']);
    expect(out['t2']!.lifecycle.map((e) => e.type)).toEqual(['entry']);
  });
});
