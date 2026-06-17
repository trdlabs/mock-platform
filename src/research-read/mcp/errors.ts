import type { GatewayError, GatewayErrorCategory, GatewayFailure } from '../../contract/research-read/mcp/dto.js';

export function gatewayError(category: GatewayErrorCategory, code: string, message: string): GatewayError {
  return { category, code, message };
}

export const BACKTEST_UNAVAILABLE_REASON = 'backtesting_moved_to_trading_backtester';

/** Every mutating/backtest tool returns this — no backtest is executed, simulated, or faked. */
export function backtestUnavailable(): GatewayFailure {
  return { ok: false, error: gatewayError('internal_gateway_error', 'backtest_unavailable', BACKTEST_UNAVAILABLE_REASON) };
}
