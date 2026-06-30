// ops.5 — mock-local mirror of trading-platform/src/operations/close_reason.ts.
// Pure: maps a recorded RAW close_reason string to the closed CloseReason union; unclassifiable → 'other'
// (raw preserved in closeReasonRaw). No DB, no SDK import — only the CloseReason type from the barrel.
import type { CloseReason } from './dto.js';

export function classifyCloseReason(raw: string | null): CloseReason | null {
  if (raw == null) return null;
  const r = raw.trim().toLowerCase();
  if (r === '') return null;

  if (r === 'tp2' || r === 'tp_final' || r === 'take_profit_final' || r.includes('final')) return 'take_profit_final';
  if (r === 'tp1' || r.startsWith('tp1') || r === 'take_profit_partial' || r.includes('partial')) return 'take_profit_partial';
  if (r === 'breakeven' || r === 'be' || r === 'be_stop' || r.includes('break_even') || r.includes('breakeven')) return 'breakeven';
  if (r.includes('trail')) return 'trailing_stop';
  if (r === 'hard_stop' || r === 'stop_loss' || r === 'sl' || r === 'stop' || r.includes('hard_stop') || r.includes('stop_loss')) return 'stop_loss';
  if (r === 'time_exit' || r === 'time' || r.includes('max_hold') || r.includes('timeout') || r.includes('time_stop')) return 'time_exit';
  if (r === 'fail_fast' || r.includes('fail_fast') || r.includes('signal') || r.includes('reversal') || r.includes('exit_now')) return 'signal_exit';
  if (r.includes('liquidat')) return 'liquidation';
  if (r === 'manual' || r === 'user' || r === 'operator' || r.includes('manual')) return 'manual';

  return 'other';
}
