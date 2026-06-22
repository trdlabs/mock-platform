import { describe, it, expect } from 'vitest';
import { checkSpecifier } from '../../scripts/verify_vendored_sdk.js';

describe('verify_vendored_sdk: checkSpecifier', () => {
  it('accepts a GitHub release-asset tgz URL specifier', () => {
    const errs = checkSpecifier({ dependencies: { '@trading-platform/sdk': 'https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.4.0/trading-platform-sdk-0.4.0.tgz' } });
    expect(errs.some((e) => e.includes('is not a GitHub release-asset'))).toBe(false);
    expect(errs.some((e) => e.includes('missing from dependencies'))).toBe(false);
  });

  it('rejects a registry specifier', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': '^0.4.0' } })
      .some((e) => e.includes('is not a GitHub release-asset'))).toBe(true);
  });

  it('rejects a vendored file: specifier (no longer permitted)', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': 'file:./vendor/trading-platform-sdk-0.4.0.tgz' } })
      .some((e) => e.includes('is not a GitHub release-asset'))).toBe(true);
  });

  it('rejects a non-release https URL', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': 'https://example.com/trading-platform-sdk-0.4.0.tgz' } })
      .some((e) => e.includes('is not a GitHub release-asset'))).toBe(true);
  });

  it('rejects a missing dependency', () => {
    expect(checkSpecifier({ dependencies: {} }).some((e) => e.includes('missing from dependencies'))).toBe(true);
  });
});
