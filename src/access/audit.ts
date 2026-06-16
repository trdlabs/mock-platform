export interface AuditRecord {
  readonly tsMs: number;
  readonly subject: string;     // hash prefix or 'local'/'anonymous' — never the raw token
  readonly resource: string;
  readonly outcome: 'accepted' | 'rejected';
}

/** Emits a redacted audit line. Never logs tokens, payloads, host paths, or credentials. */
export function auditLog(rec: AuditRecord): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ kind: 'ops_audit', ...rec }));
}
