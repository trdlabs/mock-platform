// Ambient declaration for the vendored, import-free conformance harness.
// NodeNext resolves the `./historical.conformance.mjs` import to this sibling `.d.mts`.
// The .mjs is a verbatim byte-copy of the compiled artifact from the SDK repo
// (trdlabs/sdk, conformance/historical.conformance.ts — sync-gated by
// scripts/verify_harness_sync.mjs); this file only describes the public surface the
// mock's conformance test consumes.
export interface ConformanceTarget {
  readonly baseUrl: string;
  readonly token?: string;
}
/** A check the target's dataset could not exercise (e.g. a single-symbol fixture cannot
 *  prove multi-symbol ordering). Reported when `onSkip` is supplied — a skip is NOT a pass,
 *  and this repo's conformance test fails on any non-empty skip list. */
export interface ConformanceSkip {
  readonly check: string;
  readonly reason: string;
}
export interface ConformanceOpts {
  readonly goldenRows?: readonly object[];
  readonly onSkip?: (skip: ConformanceSkip) => void;
  /** Page budget per drained query; defaults to 10 000. */
  readonly maxPages?: number;
}
export function runHistoricalConformance(
  target: ConformanceTarget,
  opts?: ConformanceOpts,
): Promise<{ ok: true }>;
