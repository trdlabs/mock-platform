import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authorize } from '../access/auth.js';
import { loadEnv } from '../env.js';
import { researchTokenAllowlist, auditResearchTool } from '../access/research-access.js';
import { openSnapshot } from '../snapshot/registry.js';
import { buildResearchServer } from '../research-read/mcp/server.js';
import { MCP031_CONTRACT_VERSION } from '../contract/research-read/mcp/version.js';

async function main(): Promise<void> {
  const env = loadEnv(); // fail-fast: невалидный env валит старт со списком всех ошибок (в stderr)
  const snapshotDir = env.MOCK_SNAPSHOT_DIR;
  const snapshotRef = env.MOCK_SNAPSHOT_REF;

  // Fail-closed startup auth (reuses Surface A's sha256 allowlist semantics; empty = spawn-trusted).
  const allowlist = researchTokenAllowlist(env);
  const auth = authorize(allowlist, env.MOCK_RESEARCH_TOKEN);
  if (!auth.ok) {
    process.stderr.write('research gateway: unauthorized (MOCK_RESEARCH_TOKEN not in MOCK_RESEARCH_TOKENS)\n');
    process.exit(1);
  }

  const snapshot = openSnapshot(snapshotDir, snapshotRef);
  // stderr ONLY — stdout is reserved for JSON-RPC framing.
  process.stderr.write(`${JSON.stringify({ kind: 'research_startup', snapshotRef, contractVersion: MCP031_CONTRACT_VERSION, authRequired: allowlist.length > 0 })}\n`);

  const subject = auth.subject ?? 'local';
  const server = buildResearchServer({
    bundle: snapshot.bundle,
    audit: (tool, outcome) => auditResearchTool({ tsMs: Date.now(), subject, resource: tool, outcome }),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`research gateway fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
