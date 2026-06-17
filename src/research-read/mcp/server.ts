import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import { GATEWAY_TOOL_NAMES } from '../../contract/research-read/mcp/version.js';
import { discoverDescriptor, listDatasets, runStatus, runResult } from './projections.js';
import { backtestUnavailable, gatewayError } from './errors.js';

export interface McpToolResult { content: Array<{ type: 'text'; text: string }> }
export interface ToolCtx {
  readonly bundle: SnapshotBundle;
  readonly audit: (tool: string, outcome: 'accepted' | 'rejected') => void;
}

function asResult(obj: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

/** Pure tool dispatch. Read tools project the snapshot; mutating tools return the unavailable envelope.
 *  Never throws — every path returns an MCP text result lab's `extractToolResult` can JSON-parse. */
export function dispatchTool(name: string, args: unknown, ctx: ToolCtx): McpToolResult {
  const a = (args ?? {}) as Record<string, unknown>;
  const runId = typeof a.runId === 'string' ? a.runId : '';
  switch (name) {
    case 'discover_research_contract': ctx.audit(name, 'accepted'); return asResult(discoverDescriptor());
    case 'list_datasets': ctx.audit(name, 'accepted'); return asResult(listDatasets());
    case 'get_run_status': ctx.audit(name, 'accepted'); return asResult(runStatus(ctx.bundle, runId));
    case 'get_run_result': ctx.audit(name, 'accepted'); return asResult(runResult(ctx.bundle, runId));
    case 'validate_module':
    case 'submit_run':
    case 'cancel_run':
    // read_artifact serves backtest/research-RUN artifacts (keyed by submit_run's runId; all ArtifactType
    // values are simulation outputs) — the honest "moved" reason, not a validation_error.
    case 'read_artifact': ctx.audit(name, 'rejected'); return asResult(backtestUnavailable());
    default: return asResult({ ok: false, error: gatewayError('validation_error', 'unknown_tool', `unknown tool ${name}`) });
  }
}

export function buildResearchServer(ctx: ToolCtx): Server {
  const server = new Server(
    { name: 'trading-mock-research-gateway', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GATEWAY_TOOL_NAMES.map((name) => ({
      name,
      description: `MCP-031 ${name} (read-only mock)`,
      inputSchema: { type: 'object' as const, properties: { runId: { type: 'string' as const } } },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = dispatchTool(req.params.name, req.params.arguments, ctx);
    return { content: result.content };
  });
  return server;
}
