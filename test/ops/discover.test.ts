import { describe, it, expect } from 'vitest';
import { buildDiscover } from '../../src/ops/handlers/discover.js';

describe('buildDiscover', () => {
  it('declares ops.5, read-only capabilities, and a closed resource catalog', () => {
    const d = buildDiscover();
    expect(d.opsContractVersion).toBe('ops.5');
    expect(d.capabilities).toEqual({
      readOnly: true, execution: false, credentials: false, ingestion: false, mutation: false,
    });
    const names = d.resources.map((r) => r.name);
    expect(names).toContain('runs');
    expect(names).toContain('source-coverage');
    expect(names).toContain('trade-evidence');
    const teRes = d.resources.find((r) => r.name === 'trade-evidence')!;
    expect(teRes.pagination).toBeNull();
    expect(teRes.supportedFilters).toEqual(['tradeIds']);
  });
});
