import { describe, it, expect } from 'vitest';
import { classifyCloseReason } from '../../src/contract/ops-read/close-reason.js';

describe('classifyCloseReason (mirror of platform close_reason.ts)', () => {
  it('maps the take-profit ladder', () => {
    expect(classifyCloseReason('tp2')).toBe('take_profit_final');
    expect(classifyCloseReason('tp_final')).toBe('take_profit_final');
    expect(classifyCloseReason('tp1')).toBe('take_profit_partial');
  });
  it('maps stops, time, signal, and the rest', () => {
    expect(classifyCloseReason('hard_stop')).toBe('stop_loss');
    expect(classifyCloseReason('stop_loss')).toBe('stop_loss');
    expect(classifyCloseReason('sl')).toBe('stop_loss');
    expect(classifyCloseReason('time_exit')).toBe('time_exit');
    expect(classifyCloseReason('be_stop')).toBe('breakeven');
    expect(classifyCloseReason('trailing')).toBe('trailing_stop');
    expect(classifyCloseReason('fail_fast')).toBe('signal_exit');
    expect(classifyCloseReason('liquidation')).toBe('liquidation');
    expect(classifyCloseReason('manual')).toBe('manual');
  });
  it('sends unknown / reconcile to other, and null/empty to null', () => {
    expect(classifyCloseReason('run_terminated')).toBe('other');
    expect(classifyCloseReason('something_new')).toBe('other');
    expect(classifyCloseReason(null)).toBeNull();
    expect(classifyCloseReason('   ')).toBeNull();
  });
});
