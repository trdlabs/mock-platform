import type { AuditRecord } from './audit.js';
import type { Env } from '../env.js';

/** sha256-hex allowlist for the research gateway (mirror of Surface A's MOCK_OPS_TOKENS).
 *  Empty = spawn-trusted. csv-парсинг (trim, отбрасывание пустых) живёт в src/env.ts. */
export function researchTokenAllowlist(env: Pick<Env, 'MOCK_RESEARCH_TOKENS'>): string[] {
  return [...env.MOCK_RESEARCH_TOKENS];
}

/** Redacted audit to STDERR — stdout is reserved for JSON-RPC framing on the stdio gateway.
 *  Never logs the raw token (subject is a hash prefix / 'local'). */
export function auditResearchTool(rec: AuditRecord): void {
  process.stderr.write(`${JSON.stringify({ kind: 'research_audit', ...rec })}\n`);
}
