import { describe, it, expect } from 'vitest';
import { checkSpecifier } from '../../scripts/verify_sdk_pin.js';

const PINNED = '0.13.0';
const NOT_EXACT = /is not an exact npm version/;

// The mock consumed the SDK as a non-registry artifact for its whole history — first a vendored
// ./vendor/*.tgz, then a GitHub release-asset URL — because no npm release existed. @trdlabs/sdk is
// published now, so every one of those forms must be rejected: these cases are the ratchet that
// stops a quiet slide back to a hand-delivered SDK.
describe('verify_sdk_pin: checkSpecifier', () => {
  it('accepts the exact pinned npm version', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': PINNED } })).toEqual([]);
  });

  it('rejects a caret range — the pin must be exact', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': `^${PINNED}` } })
      .some((e) => NOT_EXACT.test(e))).toBe(true);
  });

  it('rejects a tilde range', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': `~${PINNED}` } })
      .some((e) => NOT_EXACT.test(e))).toBe(true);
  });

  it('rejects a dist-tag', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': 'latest' } })
      .some((e) => NOT_EXACT.test(e))).toBe(true);
  });

  it('rejects a GitHub release-asset tgz URL (the previous delivery form)', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': 'https://github.com/trdlabs/sdk/releases/download/sdk-v0.11.0/trdlabs-sdk-0.11.0.tgz' } })
      .some((e) => NOT_EXACT.test(e))).toBe(true);
  });

  it('rejects a vendored file: specifier (the form before that)', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': 'file:./vendor/trdlabs-sdk-0.11.0.tgz' } })
      .some((e) => NOT_EXACT.test(e))).toBe(true);
  });

  it('rejects a git+ specifier', () => {
    expect(checkSpecifier({ dependencies: { '@trdlabs/sdk': 'git+https://github.com/trdlabs/sdk.git' } })
      .some((e) => NOT_EXACT.test(e))).toBe(true);
  });

  it('rejects an exact version other than the pinned one', () => {
    const errs = checkSpecifier({ dependencies: { '@trdlabs/sdk': '0.10.0' } });
    expect(errs.some((e) => e.includes(`expects '${PINNED}'`))).toBe(true);
    // Shape is fine here — it is the value that is wrong, so the message must not blame the shape.
    expect(errs.some((e) => NOT_EXACT.test(e))).toBe(false);
  });

  it('rejects the legacy package name', () => {
    expect(checkSpecifier({ dependencies: { '@trading-platform/sdk': PINNED } })
      .some((e) => e.includes('missing from dependencies'))).toBe(true);
  });

  it('rejects a missing dependency', () => {
    expect(checkSpecifier({ dependencies: {} })
      .some((e) => e.includes('missing from dependencies'))).toBe(true);
  });

  it('agrees with the real package.json', async () => {
    const pkg = JSON.parse(
      await import('node:fs').then((fs) => fs.readFileSync('package.json', 'utf8')),
    ) as { dependencies?: Record<string, string> };
    expect(checkSpecifier(pkg)).toEqual([]);
  });
});
