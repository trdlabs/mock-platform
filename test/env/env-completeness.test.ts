import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Contract gate «Полнота схемы»: src/env.ts is the ONLY module reading process.env.
// Everything else imports the parsed `env`. Test files are exempt where they BUILD a child
// process environment ({ ...process.env, X: 'y' }) — that is construction, not configuration reads.
describe('env.ts is the single point of process.env reads', () => {
  it('no process.env outside src/env.ts in src/, scripts/ and tools/', () => {
    const tracked = execFileSync('git', ['ls-files', 'src', 'scripts', 'tools'], { encoding: 'utf8' })
      .split('\n')
      .filter((p) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(p))
      .filter((p) => !p.endsWith('.test.ts'));
    const offenders: string[] = [];
    for (const p of tracked) {
      if (p === 'src/env.ts') continue;
      const src = readFileSync(p, 'utf8');
      if (/process\.env/.test(src)) offenders.push(p);
    }
    expect(offenders, `process.env read outside src/env.ts:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
