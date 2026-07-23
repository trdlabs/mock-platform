import { describe, it, expect, vi } from 'vitest';
import { researchTokenAllowlist, auditResearchTool } from '../../src/access/research-access.js';

describe('research access', () => {
  it('materialises the parsed MOCK_RESEARCH_TOKENS allowlist (csv trimming lives in src/env.ts)', () => {
    expect(researchTokenAllowlist({ MOCK_RESEARCH_TOKENS: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(researchTokenAllowlist({ MOCK_RESEARCH_TOKENS: [] })).toEqual([]);
  });
  it('auditResearchTool writes to STDERR (never stdout) and never logs a token', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    auditResearchTool({ tsMs: 1, subject: 'local', resource: 'discover_research_contract', outcome: 'accepted' });
    expect(outSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledOnce();
    const line = String(errSpy.mock.calls[0]![0]);
    expect(line).toContain('research_audit');
    expect(line).toContain('discover_research_contract');
    errSpy.mockRestore(); outSpy.mockRestore();
  });
});
