export const MCP031_CONTRACT_VERSION = '017.2';
export const MCP031_SUPPORTED_CONTRACT_VERSIONS = ['017.1', '017.2'] as const;
export const MCP031_METRIC_CATALOG = [
  'pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct',
] as const;
export const MCP031_ROBUSTNESS_CATALOG = ['walk_forward', 'oos_split'] as const;
export const MCP031_MARKET_DATA_KINDS = ['openInterest', 'liquidations', 'funding', 'taker'] as const;
export const GATEWAY_TOOL_NAMES = [
  'discover_research_contract', 'list_datasets', 'validate_module', 'submit_run',
  'cancel_run', 'get_run_status', 'get_run_result', 'read_artifact',
] as const;
export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[number];
