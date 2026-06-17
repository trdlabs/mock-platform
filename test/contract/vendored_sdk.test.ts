import { describe, it, expect } from 'vitest';
import { checkSpecifier } from '../../scripts/verify_vendored_sdk.js';

describe('verify_vendored_sdk: checkSpecifier', () => {
  it('accepts a vendored ./vendor/*.tgz file: specifier', () => {
    const errs = checkSpecifier({ dependencies: { '@trading-platform/sdk': 'file:./vendor/trading-platform-sdk-0.3.0.tgz' } });
    // existence of the file is environment-dependent; assert no SPECIFIER-shape error
    expect(errs.some((e) => e.includes('not a vendored'))).toBe(false);
    expect(errs.some((e) => e.includes('missing from dependencies'))).toBe(false);
  });

  it('rejects a registry or non-vendored specifier', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': '^0.3.0' } })
      .some((e) => e.includes('not a vendored'))).toBe(true);
  });

  it('rejects a file: path not under ./vendor/', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': 'file:./node_modules/trading-platform-sdk-0.3.0.tgz' } })
      .some((e) => e.includes('not a vendored'))).toBe(true);
  });

  it('rejects a missing dependency', () => {
    expect(checkSpecifier({ dependencies: {} }).some((e) => e.includes('missing from dependencies'))).toBe(true);
  });
});
