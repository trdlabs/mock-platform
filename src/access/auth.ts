import { createHash } from 'node:crypto';

export interface AuthResult { readonly ok: boolean; readonly subject?: string; }

/** Empty allowlist = loopback-trusted (open). Otherwise sha256(token) must be allowlisted. */
export function authorize(allowlist: readonly string[], rawToken: string | undefined): AuthResult {
  if (allowlist.length === 0) return { ok: true, subject: 'local' };
  if (!rawToken) return { ok: false };
  const h = createHash('sha256').update(rawToken).digest('hex');
  if (allowlist.includes(h)) return { ok: true, subject: h.slice(0, 16) };
  return { ok: false };
}

/** Parse `Authorization: Bearer <t>` (case-insensitive). */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}
