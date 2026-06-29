# Synthetic extended historical fixture (`2026-06-16-to-18-extended`)

**Date:** 2026-06-29
**Status:** Approved

## Goal

Provide a committed snapshot fixture with ~3 continuous days of 1-minute
`CanonicalRowV2` rows, so the downstream consumer (trading-lab `commitXTermMath`)
can resample 1m → 1h and render the 1h term, which needs ≥ 28 hourly bars. The
current real-day fixture `2026-06-18-real-all` carries only ~24 hourly buckets
(one day) and the 1h term is dropped.

## Approach

Deterministic, network-free replication of the real day **backward** in time by
two whole days. Take fixture `2026-06-18-real-all` (the source) and, for each
historical series, prepend two shifted copies of the day:

```
extended = [ day shifted −2d ] ++ [ day shifted −1d ] ++ [ original day ]
```

Only the timestamp field changes (`minute_ts − k·86_400_000` for rows, `tsMs −
k·86_400_000` for bars/funding/oi/liq); every other field is copied verbatim.
This is **not** a real VPS fetch — the manifest declares it as synthetic.

### Why backward (tail pinned)

The downstream pins research `ts = 2026-06-18T23:59:00Z` with a 7-day window. The
series tail must stay on `minute_ts = 1781827140000`. Extending backward keeps
the tail untouched; the window now covers all 3 days.

### Scope of extension

All five `historical` maps are replicated to 3 days (per user decision):
`rowsBySymbol`, `barsBySymbolAndTimeframe` (per timeframe), `fundingBySymbol`,
`openInterestBySymbol`, `liquidationsBySymbol`. A whole-day shift (86_400_000 ms)
is an integer multiple of every timeframe bucket (1m…1d divide a day), so bar
alignment is preserved.

Everything else in the bundle (`runs`, `tradesByRun`, health surfaces, …) is
**verbatim** — the real trades stay on their real timestamps within day 0.
Fabricating trade history for 06-16 / 06-17 (when the bot did not trade) would be
dishonest. We extend the market backdrop, not the trading results.

## Components

- `scripts/make-extended-fixture.ts` — authoring tool (deterministic, no network,
  no `Date.now()`), modeled on `scripts/make-golden-fixture.ts`.
  1. `loadSnapshot(SOURCE)` → validated bundle; read source `manifest.json` for `createdAtMs`.
  2. `triplicate(arr, tsKey)` → `[...−2d, ...−1d, ...orig]`, shifting only `tsKey`.
  3. Apply to all five historical maps; deep-clone the rest verbatim.
  4. Build manifest from version constants (`SNAPSHOT_SCHEMA_VERSION`,
     `OPS_READ_CONTRACT_VERSION`, `RESEARCH_READ_CONTRACT_VERSION`,
     `ANALYSIS_CONTRACT_VERSION`) so the compat gate passes;
     `exporterVersion: 'synthetic-extend.1'`,
     `sourcePlatformCommit: 'synthetic-extend-of:2026-06-18-real-all'`,
     `createdAtMs` copied from source manifest.
  5. Checksum-safe write: `const s = JSON.stringify(bundle); writeFile(s);
     checksums = { 'ops/bundle.json': sha256Hex(s) }`. Manifest/checksums pretty;
     the hash is over the exact bundle string only.
  6. Self-validate: `scanText(s)` then `loadSnapshot(outDir)`.
- Output: `data/snapshots/fixtures/2026-06-16-to-18-extended/{manifest.json,ops/bundle.json,checksums.json}`.

## Invariants (machine-checked by `loadSnapshot` + the test)

- Manifest schema + exact-version compat + bundle Ajv schema (`additionalProperties:false`).
- Checksum matches the exact written bundle bytes.
- Per symbol: `minute_ts` strictly increasing, all `% 60000 === 0`, no dups
  (whole-day shift guarantees disjoint, ordered blocks).
- Range: first `= 1781568000000` (2026-06-16T00:00Z), last `= 1781827140000`
  (2026-06-18T23:59Z). Tail = exact verbatim copy of the source day.
- All 19 `CanonicalRowV2` fields present; `taker_*` null exactly where the source is.
- 1m → 1h resample yields ≥ 28 distinct hourly buckets per symbol
  (ESPORTSUSDT 24/day → 72; REUSDT 10/day → 30).

## Manifest coverage

`MANIFEST_SCHEMA` carries only `ref/createdAtMs/versions/bundleRef/checksumsRef`
— no static window/coverage field. Historical coverage is not a bundle field
(`historicalBundle` has none); it is computed at serve time from the data.
Extending the maps auto-extends coverage. **No manifest coverage edit needed.**

## Known, accepted limitations

- **REUSDT** is a partial source day (~550 rows, 14:49–23:59). After triplication
  it is three non-adjacent ~9h chunks with gaps between days → its 1h series has
  holes (30 buckets, non-smooth). Not a blocker: the demo symbol is ESPORTSUSDT
  (full day, 72 clean buckets).
- **Day seams**: verbatim copies create a close(23:59) → open(00:00) jump at the
  two −2d/−1d/0d boundaries → a couple of anomalous returns/ATR/realizedVol
  spikes. Accepted for a demo (markets gap); chosen for low risk over synthetic
  smoothing.

## Testing

`test/snapshot/extended-fixture.test.ts` (vitest), written test-first:
loadSnapshot ok; every map symbol ×3; strict monotonicity / 60000-alignment / 19
fields; range + verbatim tail; ≥28 hourly buckets per symbol; source fixture
`2026-06-18-real-all` unchanged.

## Downstream / image

`Dockerfile` does `COPY data/snapshots/fixtures …` → fixtures are baked into the
image. After merge the image must be rebuilt/published; downstream then flips
`MOCK_SNAPSHOT_REF=fixtures/2026-06-16-to-18-extended` (one line; ESPORTSUSDT is
already default, the 06-18 ts pin is preserved).
