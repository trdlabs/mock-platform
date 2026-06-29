import { describe, it, expect } from 'vitest';
import { assertSnapshotCompatible } from '../../src/snapshot/compat.js';
import type { SnapshotVersions } from '../../src/contract/snapshot/manifest.js';

const base: SnapshotVersions = {
  snapshotSchemaVersion: 'snapshot.1',
  opsReadContractVersion: 'ops.4',
  researchReadContractVersion: 'research.1',
  analysisContractVersion: 'ops.4',
  exporterVersion: 'exp.1',
  sourcePlatformCommit: 'abc123',
  redactionPolicyVersion: 'redact.1',
};

describe('assertSnapshotCompatible', () => {
  it('accepts a snapshot whose contract versions EXACTLY match the supported set', () => {
    expect(() => assertSnapshotCompatible(base)).not.toThrow();
  });
  it('fails closed on an unsupported snapshot schema version', () => {
    expect(() => assertSnapshotCompatible({ ...base, snapshotSchemaVersion: 'snapshot.2' }))
      .toThrow(/unsupported snapshotSchemaVersion 'snapshot\.2'/i);
  });
  it('fails closed on a higher ops-read contract version', () => {
    expect(() => assertSnapshotCompatible({ ...base, opsReadContractVersion: 'ops.99' }))
      .toThrow(/unsupported opsReadContractVersion/i);
  });
  it('fails closed on an OLDER ops-read minor (ops.3 is NOT compatible with ops.4 in MVP)', () => {
    expect(() => assertSnapshotCompatible({ ...base, opsReadContractVersion: 'ops.3' }))
      .toThrow(/unsupported opsReadContractVersion 'ops\.3'/i);
  });
});
