/** Defense-in-depth blocklist over an already-sanitized snapshot. Sanitization is primarily an
 *  operator-side allowlist projection; this catches leaks that slipped through. Applied to BOTH
 *  manifest and bundle text by the loader. Fail closed. */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['jwt / bearer token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/],
  ['absolute unix host path', /(?:"|')\/(?:home|root|etc|var|usr|opt)\//],
  ['windows host path', /[A-Za-z]:\\\\(?:Users|home)\\\\/],
  ['db connection url', /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s"']+/],
];

export function scanForSecrets(name: string, content: string): void {
  for (const [label, re] of FORBIDDEN) {
    if (re.test(content)) {
      throw new Error(`snapshot safety: forbidden pattern '${label}' detected in ${name} — refusing to load`);
    }
  }
}
