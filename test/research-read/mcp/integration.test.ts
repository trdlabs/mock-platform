import { describe, it, expect, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseToolResult(res: Record<string, unknown>): unknown {
  if ('structuredContent' in res && res.structuredContent !== undefined) return res.structuredContent;
  const content = res.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text).join('');
    if (text) return JSON.parse(text);
  }
  return content;
}

async function callTool(c: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await c.callTool({ name, arguments: args });
  return parseToolResult(res as unknown as Record<string, unknown>);
}

let client: Client | undefined;
let transport: StdioClientTransport | undefined;

describe('research MCP gateway (real stdio, end-to-end)', () => {
  it('lab-style client reads the gateway over stdio (proves stdout is clean JSON-RPC)', async () => {
    transport = new StdioClientTransport({
      command: 'tsx',
      args: ['src/bin/start-research-mcp.ts'],
      env: { ...process.env, MOCK_SNAPSHOT_REF: 'fixtures/2026-06-16-synthetic' },
    });
    client = new Client({ name: 'test-lab', version: '0' });
    await client.connect(transport); // handshake FAILS if the gateway pollutes stdout

    const discover = await callTool(client, 'discover_research_contract', {}) as { contractVersion: string; supportedContractVersions: string[] };
    expect(discover.contractVersion).toBe('017.2');
    expect(discover.supportedContractVersions).toContain('017.2');

    const datasets = await callTool(client, 'list_datasets', {}) as { datasets: unknown[] };
    expect(datasets.datasets).toEqual([]);

    const status = await callTool(client, 'get_run_status', { runId: 'run_paper_002' }) as { ok: boolean; view?: { status: string } };
    expect(status.ok).toBe(true);
    expect(status.view!.status).toBe('completed');

    const result = await callTool(client, 'get_run_result', { runId: 'run_paper_002' }) as { ok: boolean; kind?: string; summary?: { metrics: Record<string, number> } };
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('summary');
    expect(result.summary!.metrics.pnl).toBeCloseTo(24.25);

    // non-terminal (running) run → the status arm, never a fabricated terminal summary
    const live = await callTool(client, 'get_run_result', { runId: 'run_live_001' }) as { ok: boolean; kind?: string; view?: { status: string } };
    expect(live.ok).toBe(true);
    expect(live.kind).toBe('status');
    expect(live.view!.status).toBe('running');

    const submit = await callTool(client, 'submit_run', {}) as { ok: boolean; error?: { message: string } };
    expect(submit.ok).toBe(false);
    expect(submit.error!.message).toBe('backtesting_moved_to_trading_backtester');
  }, 30000);
});

afterAll(async () => { await client?.close(); await transport?.close(); });
