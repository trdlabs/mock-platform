import { describe, it, expect } from 'vitest';
import { violationFor } from '../../scripts/verify_contract_isolation.js';

describe('verify_contract_isolation: A3 SDK-seam rule', () => {
  it('allows @trdlabs/sdk in both designated seam files', () => {
    expect(violationFor('src/contract/ops-read/dto.sdk.ts', '@trdlabs/sdk/ops-read')).toBeNull();
    expect(violationFor('src/contract/historical-read/dto.sdk.ts', '@trdlabs/sdk/historical')).toBeNull();
  });

  it('rejects @trdlabs/sdk in research-read (it must stay extractable)', () => {
    const v = violationFor('src/contract/research-read/dto.ts', '@trdlabs/sdk/ops-read');
    expect(v).toContain('ONLY in src/contract/ops-read/dto.sdk.ts');
  });

  it('rejects @trdlabs/sdk even in a sibling ops-read file', () => {
    expect(violationFor('src/contract/ops-read/dto.local.ts', '@trdlabs/sdk')).not.toBeNull();
  });

  // The SDK moved @trading-platform/sdk -> @trdlabs/sdk (mock-contract-parity item 5). The legacy
  // name is not merely un-seamed, it is an ordinary forbidden package now — denied even in the seam
  // files, which is what stops a half-finished revert from type-checking its way back in.
  it('rejects the legacy @trading-platform/sdk name everywhere, seam files included', () => {
    for (const f of [
      'src/contract/ops-read/dto.sdk.ts',
      'src/contract/historical-read/dto.sdk.ts',
      'src/contract/research-read/dto.ts',
    ]) {
      expect(violationFor(f, '@trading-platform/sdk/ops-read')).toContain('dependency-free');
    }
  });

  it('still rejects any other bare package anywhere in the contract layer', () => {
    expect(violationFor('src/contract/ops-read/dto.sdk.ts', 'lodash')).toContain('dependency-free');
  });

  it('allows node: and in-tree relative imports', () => {
    expect(violationFor('src/contract/ops-read/dto.local.ts', './dto.sdk.js')).toBeNull();
    expect(violationFor('src/contract/snapshot/bundle.ts', '../ops-read/dto.js')).toBeNull();
    expect(violationFor('src/contract/ops-read/version.ts', 'node:path')).toBeNull();
  });

  it('flags a relative import that escapes the contract root', () => {
    expect(violationFor('src/contract/ops-read/dto.ts', '../../snapshot/loader.js')).toContain('escapes');
  });
});
