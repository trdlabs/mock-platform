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
});
