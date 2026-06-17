import type { AuditRecord } from './audit.js';

/** sha256-hex allowlist for the research gateway (mirror of Surface A's MOCK_OPS_TOKENS). Empty = spawn-trusted. */
export function researchTokenAllowlist(env: Record<string, string | undefined>): string[] {
  return (env.MOCK_RESEARCH_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Redacted audit to STDERR — stdout is reserved for JSON-RPC framing on the stdio gateway.
 *  Never logs the raw token (subject is a hash prefix / 'local'). */
export function auditResearchTool(rec: AuditRecord): void {
  process.stderr.write(`${JSON.stringify({ kind: 'research_audit', ...rec })}\n`);
}
