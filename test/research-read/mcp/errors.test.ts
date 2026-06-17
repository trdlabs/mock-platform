import { describe, it, expect } from 'vitest';
import { gatewayError, backtestUnavailable, BACKTEST_UNAVAILABLE_REASON } from '../../../src/research-read/mcp/errors.js';

describe('gateway errors', () => {
  it('gatewayError builds the required {category,code,message}', () => {
    expect(gatewayError('validation_error', 'x', 'msg')).toEqual({ category: 'validation_error', code: 'x', message: 'msg' });
  });
  it('backtestUnavailable is an ok:false envelope carrying the migration reason', () => {
    const r = backtestUnavailable();
    expect(r.ok).toBe(false);
    expect(r.error.category).toBe('internal_gateway_error');
    expect(r.error.message).toBe(BACKTEST_UNAVAILABLE_REASON);
    expect(BACKTEST_UNAVAILABLE_REASON).toBe('backtesting_moved_to_trading_backtester');
  });
});
