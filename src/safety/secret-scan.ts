/** Defense-in-depth blocklist over an already-sanitized snapshot. Sanitization is primarily an
 *  operator-side allowlist projection; this catches leaks that slipped through. Applied to BOTH
 *  manifest and bundle text by the loader, and (via `scanText`) to committed data files by the CI guard.
 *  Fail closed. */
export const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['jwt / bearer token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/],
  ['absolute unix host path', /(?:"|')\/(?:home|root|etc|var|usr|opt)\//],
  ['windows host path', /[A-Za-z]:\\\\(?:Users|home)\\\\/],
  ['db connection url', /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"']+/],
];

/** Pure: returns the labels of every forbidden pattern found in `content` (`[]` = clean). */
export function scanText(content: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of FORBIDDEN) {
    if (re.test(content)) hits.push(label);
  }
  return hits;
}

export function scanForSecrets(name: string, content: string): void {
  const hits = scanText(content);
  if (hits.length > 0) {
    throw new Error(`snapshot safety: forbidden pattern '${hits[0]}' detected in ${name} — refusing to load`);
  }
}
