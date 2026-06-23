# Taker-flow Snapshot Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fetch-snapshot` capture the platform's feature-028 taker-flow columns and emit them as per-minute `CanonicalRowV2` rows (`historical.rowsBySymbol`), then carry those rows losslessly through the fixture-authoring tool — so a fresh post-028 fetch produces a loss-bearing demo fixture whose historical data exposes funding + raw taker (CVD lab-derived).

**Architecture:** The mock's READ surface and contract already model taker (`canonicalRowV2` + `historical.rowsBySymbol`; `readRows` already prefers `rowsBySymbol`). The gap is INGEST-only: the parquet reader drops the `taker_*` columns and never builds canonical rows. We (1) read `taker_buy_volume_usd`/`taker_sell_volume_usd` from `schema_version=2` parquet parts, (2) emit one `CanonicalRowV2` per source minute carrying taker, (3) pass `rowsBySymbol` through `make-fixture`'s symbol filter. CVD is never stored — derived downstream by the lab.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 20+, vitest, `tsx` for tool/script execution, hyparquet (authoring-side only).

## Global Constraints

- `src/contract/**` stays import-clean and extractable; the ONLY contract file allowed to import the SDK is `src/contract/ops-read/dto.sdk.ts` (enforced by `pnpm verify:contract-isolation`). This plan adds NO contract-file imports.
- No `pg` / `ccxt` / exchange SDK / private-platform-package imports anywhere shippable (`pnpm verify:no-forbidden-deps`). `fetch-snapshot` is authoring-side and already imports `hyparquet` dynamically — do not add new runtime deps.
- ESM with explicit `.js` extensions on relative imports; `tsc` runs with `noUncheckedIndexedAccess`.
- `CanonicalRowV2` is the frozen 19-field shape (feature 028): `schema_version, minute_ts, symbol, open, high, low, close, volume, turnover, oi_total_usd, funding_rate, liq_long_usd, liq_short_usd, has_oi, has_funding, has_liquidations, taker_buy_volume_usd, taker_sell_volume_usd, has_taker_flow`. Do not add fields. `schema_version` is the literal `2`.
- CVD is NOT a stored column (canon: derived from buy/sell). Do not add a cvd field anywhere.
- Full gate: `pnpm check:ci` (= `typecheck` + `verify:contract-isolation` + `test` + `verify:no-forbidden-deps` + `verify:no-secrets` + `verify:vendored-sdk` + `verify:harness-sync`). Single tests: `pnpm test -- <path>`.

---

### Task 1: `aggregateHistorical` emits per-minute `CanonicalRowV2` rows with taker

**Files:**
- Modify: `tools/fetch-snapshot/fetch-snapshot.ts` (interfaces `MinuteRow`, `HistoricalBundle`; add `CanonicalRowV2`; functions `aggregateHistorical`, `emptyHistorical`)
- Test: `test/scripts/aggregate-historical.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface MinuteRow` gains `takerBuy: number | null; takerSell: number | null;`
  - tool-local `interface CanonicalRowV2` (19 fields, `schema_version: 2`)
  - `HistoricalBundle` gains `rowsBySymbol: Record<string, CanonicalRowV2[]>;`
  - `export function aggregateHistorical(bySymbol: Record<string, MinuteRow[]>): HistoricalBundle` — now also populates `rowsBySymbol`.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/aggregate-historical.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregateHistorical, type MinuteRow } from '../../tools/fetch-snapshot/fetch-snapshot.js';

const minute = (over: Partial<MinuteRow>): MinuteRow => ({
  ts: 1_781_220_000_000,
  sym: 'ESPORTSUSDT',
  open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
  oi: null, funding: null, liqLong: null, liqShort: null,
  takerBuy: null, takerSell: null,
  ...over,
});

describe('aggregateHistorical → rowsBySymbol', () => {
  it('emits one canonical v2 row per minute with taker carried through', () => {
    const rows = [
      minute({ ts: 1_781_220_000_000, close: 1.5, volume: 100, takerBuy: 600, takerSell: 400 }),
      minute({ ts: 1_781_220_060_000, close: 2.0, volume: 50, oi: 9_000, funding: 0.0001 }),
    ];
    const out = aggregateHistorical({ ESPORTSUSDT: rows });
    const r = out.rowsBySymbol['ESPORTSUSDT'];
    expect(r).toHaveLength(2);

    expect(r![0]).toMatchObject({
      schema_version: 2,
      minute_ts: 1_781_220_000_000,
      symbol: 'ESPORTSUSDT',
      close: 1.5,
      turnover: 150, // volume * close
      taker_buy_volume_usd: 600,
      taker_sell_volume_usd: 400,
      has_taker_flow: true,
      has_oi: false,
      funding_rate: null,
      has_funding: false,
    });

    expect(r![1]).toMatchObject({
      taker_buy_volume_usd: null,
      taker_sell_volume_usd: null,
      has_taker_flow: false,
      oi_total_usd: 9_000,
      has_oi: true,
      funding_rate: 0.0001,
      has_funding: true,
    });
  });

  it('rows are sorted ascending and deduped by minute_ts (last-wins)', () => {
    const out = aggregateHistorical({
      ESPORTSUSDT: [
        minute({ ts: 1_781_220_060_000, close: 9 }),
        minute({ ts: 1_781_220_000_000, close: 1 }),
        minute({ ts: 1_781_220_060_000, close: 2 }), // dup ts → wins
      ],
    });
    const r = out.rowsBySymbol['ESPORTSUSDT']!;
    expect(r.map((x) => x.minute_ts)).toEqual([1_781_220_000_000, 1_781_220_060_000]);
    expect(r[1]!.close).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/scripts/aggregate-historical.test.ts`
Expected: FAIL — `out.rowsBySymbol` is `undefined` (property does not exist) / type error on `takerBuy`.

- [ ] **Step 3: Add the `CanonicalRowV2` interface and extend `MinuteRow` / `HistoricalBundle`**

In `tools/fetch-snapshot/fetch-snapshot.ts`, find the historical interfaces block:

```ts
interface FundingEntry { tsMs: number; symbol: string; rate: number; }
interface OIEntry { tsMs: number; symbol: string; openInterestUsd: number; }
interface LiqEntry { tsMs: number; symbol: string; side: 'long' | 'short'; sizeUsd: number; }

interface HistoricalBundle {
  barsBySymbolAndTimeframe: Record<string, Record<string, Bar[]>>;
  fundingBySymbol: Record<string, FundingEntry[]>;
  openInterestBySymbol: Record<string, OIEntry[]>;
  liquidationsBySymbol: Record<string, LiqEntry[]>;
}
```

Replace it with:

```ts
interface FundingEntry { tsMs: number; symbol: string; rate: number; }
interface OIEntry { tsMs: number; symbol: string; openInterestUsd: number; }
interface LiqEntry { tsMs: number; symbol: string; side: 'long' | 'short'; sizeUsd: number; }

/** Canonical row v2 (feature 028). Frozen 19-field shape; mirrors the contract canonicalRowV2. */
interface CanonicalRowV2 {
  schema_version: 2;
  minute_ts: number;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  oi_total_usd: number | null;
  funding_rate: number | null;
  liq_long_usd: number | null;
  liq_short_usd: number | null;
  has_oi: boolean;
  has_funding: boolean;
  has_liquidations: boolean;
  taker_buy_volume_usd: number | null;
  taker_sell_volume_usd: number | null;
  has_taker_flow: boolean;
}

interface HistoricalBundle {
  barsBySymbolAndTimeframe: Record<string, Record<string, Bar[]>>;
  fundingBySymbol: Record<string, FundingEntry[]>;
  openInterestBySymbol: Record<string, OIEntry[]>;
  liquidationsBySymbol: Record<string, LiqEntry[]>;
  rowsBySymbol: Record<string, CanonicalRowV2[]>;
}
```

Then find the `MinuteRow` interface and add the two taker fields after `liqShort`:

```ts
export interface MinuteRow {
  ts: number;
  sym: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
  funding: number | null;
  liqLong: number | null;
  liqShort: number | null;
  takerBuy: number | null;
  takerSell: number | null;
}
```

- [ ] **Step 4: Emit `rowsBySymbol` in `aggregateHistorical` and `emptyHistorical`**

In `aggregateHistorical`, add a `rowsBySymbol` accumulator next to the others:

```ts
  const liquidationsBySymbol: Record<string, LiqEntry[]> = {};
  const rowsBySymbol: Record<string, CanonicalRowV2[]> = {};
```

Inside the `for (const [sym, rows] of Object.entries(bySymbol))` loop, AFTER the
`liquidationsBySymbol[sym] = liqEntries;` line and before the loop closes, add:

```ts
    // Canonical v2 rows — одна строка на минуту, дедуп по minute_ts (last-wins), taker сквозной.
    const rowMap = new Map<number, CanonicalRowV2>();
    for (const r of rows) {
      rowMap.set(r.ts, {
        schema_version: 2,
        minute_ts: r.ts,
        symbol: sym,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        turnover: r.volume * r.close,
        oi_total_usd: r.oi,
        funding_rate: r.funding,
        liq_long_usd: r.liqLong,
        liq_short_usd: r.liqShort,
        has_oi: r.oi !== null,
        has_funding: r.funding !== null,
        has_liquidations: r.liqLong !== null || r.liqShort !== null,
        taker_buy_volume_usd: r.takerBuy,
        taker_sell_volume_usd: r.takerSell,
        has_taker_flow: r.takerBuy !== null || r.takerSell !== null,
      });
    }
    rowsBySymbol[sym] = [...rowMap.values()].sort((a, b) => a.minute_ts - b.minute_ts);
```

Update the return statement:

```ts
  return { barsBySymbolAndTimeframe, fundingBySymbol, openInterestBySymbol, liquidationsBySymbol, rowsBySymbol };
```

Update `emptyHistorical`:

```ts
function emptyHistorical(): HistoricalBundle {
  return { barsBySymbolAndTimeframe: {}, fundingBySymbol: {}, openInterestBySymbol: {}, liquidationsBySymbol: {}, rowsBySymbol: {} };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- test/scripts/aggregate-historical.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (every `MinuteRow` literal in the tool now needs `takerBuy`/`takerSell`; the only producer is `readParquetDir`, fixed in Task 2 — if `tsc` flags it here, proceed to Task 2 which adds those fields).

- [ ] **Step 7: Commit**

```bash
git add tools/fetch-snapshot/fetch-snapshot.ts test/scripts/aggregate-historical.test.ts
git commit -m "feat(fetch-snapshot): emit per-minute CanonicalRowV2 rows with taker in aggregateHistorical"
```

---

### Task 2: `readParquetDir` reads the v2 taker columns into `MinuteRow`

**Files:**
- Modify: `tools/fetch-snapshot/fetch-snapshot.ts` (add `parquetColumnsFor`; edit `readParquetDir` column list + row mapping)
- Test: `test/scripts/parquet-columns.test.ts` (create)

**Interfaces:**
- Consumes: `MinuteRow.takerBuy/takerSell` from Task 1.
- Produces: `export function parquetColumnsFor(sv: 1 | 2): string[]`.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/parquet-columns.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parquetColumnsFor } from '../../tools/fetch-snapshot/fetch-snapshot.js';

describe('parquetColumnsFor', () => {
  it('requests the taker columns for schema_version=2 parts', () => {
    const cols = parquetColumnsFor(2);
    expect(cols).toContain('taker_buy_volume_usd');
    expect(cols).toContain('taker_sell_volume_usd');
  });

  it('does NOT request taker columns for schema_version=1 parts', () => {
    const cols = parquetColumnsFor(1);
    expect(cols).not.toContain('taker_buy_volume_usd');
    expect(cols).not.toContain('taker_sell_volume_usd');
  });

  it('always includes the base canonical columns', () => {
    for (const sv of [1, 2] as const) {
      expect(parquetColumnsFor(sv)).toEqual(
        expect.arrayContaining(['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd']),
      );
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/scripts/parquet-columns.test.ts`
Expected: FAIL — `parquetColumnsFor` is not exported / not defined.

- [ ] **Step 3: Add `parquetColumnsFor` and wire it into `readParquetDir`**

In `tools/fetch-snapshot/fetch-snapshot.ts`, add this exported helper just above `async function readParquetDir`:

```ts
/** Parquet columns to read per schema version. v2 adds the additive taker quote-volume columns. */
export function parquetColumnsFor(sv: 1 | 2): string[] {
  const base = ['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
    'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd'];
  return sv === 2 ? [...base, 'taker_buy_volume_usd', 'taker_sell_volume_usd'] : base;
}
```

Inside `readParquetDir`, replace the inline `columns` ternary:

```ts
    const columns = sv === 2
      ? ['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd']
      : ['minute_ts', 'symbol', 'open', 'high', 'low', 'close', 'volume',
          'oi_total_usd', 'funding_rate', 'liq_long_usd', 'liq_short_usd'];
```

with:

```ts
    const columns = parquetColumnsFor(sv);
```

- [ ] **Step 4: Map the taker columns into the pushed `MinuteRow`**

In the same `readParquetDir`, find the `bySymbol[sym]!.push({ ... })` block and add the two taker
fields after `liqShort` (the `sv` variable is in scope from the `for (const { path, sv } of partFiles)` loop):

```ts
      bySymbol[sym]!.push({
        ts,
        sym,
        open: toNum(r['open']),
        high: toNum(r['high']),
        low: toNum(r['low']),
        close: toNum(r['close']),
        volume: toNum(r['volume']),
        oi: toNumOrNull(r['oi_total_usd']),
        funding: toNumOrNull(r['funding_rate']),
        liqLong: toNumOrNull(r['liq_long_usd']),
        liqShort: toNumOrNull(r['liq_short_usd']),
        takerBuy: sv === 2 ? toNumOrNull(r['taker_buy_volume_usd']) : null,
        takerSell: sv === 2 ? toNumOrNull(r['taker_sell_volume_usd']) : null,
      });
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test -- test/scripts/parquet-columns.test.ts`
Expected: PASS.

Run: `pnpm typecheck`
Expected: no errors (the `MinuteRow` literal now satisfies the Task-1 interface).

- [ ] **Step 6: Commit**

```bash
git add tools/fetch-snapshot/fetch-snapshot.ts test/scripts/parquet-columns.test.ts
git commit -m "feat(fetch-snapshot): read taker_buy/sell_volume_usd from schema_version=2 parquet"
```

---

### Task 3: `make-fixture` carries `rowsBySymbol` through the symbol filter

**Files:**
- Modify: `scripts/make-fixture.ts` (`RawHistorical`, `BundleLike.historical`, `filterBundleToSymbols`)
- Test: `test/scripts/make-fixture.test.ts` (extend the existing `sample` + add a case)

**Interfaces:**
- Consumes: the `rowsBySymbol` map shape produced by Task 1 (per-symbol arrays).
- Produces: `filterBundleToSymbols` output whose `historical.rowsBySymbol` is restricted to the kept symbols (only when the input carries it).

- [ ] **Step 1: Write the failing test**

In `test/scripts/make-fixture.test.ts`, add `rowsBySymbol` to the `historical` block of the `sample` const:

```ts
  historical: {
    barsBySymbolAndTimeframe: { A: { '1h': [] }, B: { '1h': [] }, C: { '1h': [] }, D: { '1h': [] } },
    fundingBySymbol: { A: [], B: [], C: [], D: [] },
    openInterestBySymbol: { A: [], B: [], C: [], D: [] },
    liquidationsBySymbol: { A: [], B: [], C: [], D: [] },
    rowsBySymbol: { A: [], B: [], C: [], D: [] },
  },
```

Add a new test case inside the `describe('filterBundleToSymbols', ...)` block:

```ts
  it('filters rowsBySymbol to the chosen symbols when present', () => {
    expect(Object.keys(out.historical!.rowsBySymbol!).sort()).toEqual(['A', 'B']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/scripts/make-fixture.test.ts`
Expected: FAIL — `out.historical.rowsBySymbol` is `undefined` (the filter drops it).

- [ ] **Step 3: Extend the `make-fixture` types**

In `scripts/make-fixture.ts`, add `rowsBySymbol` to `RawHistorical`:

```ts
interface RawHistorical {
  barsBySymbolAndTimeframe: Record<string, Record<string, unknown[]>>;
  fundingBySymbol: Record<string, unknown[]>;
  openInterestBySymbol: Record<string, unknown[]>;
  liquidationsBySymbol: Record<string, unknown[]>;
  rowsBySymbol?: Record<string, unknown[]>;
}
```

And to the `historical` member of `BundleLike`:

```ts
  readonly historical?: {
    readonly barsBySymbolAndTimeframe: { readonly [k: string]: { readonly [tf: string]: ReadonlyArray<unknown> } };
    readonly fundingBySymbol: { readonly [k: string]: ReadonlyArray<unknown> };
    readonly openInterestBySymbol: { readonly [k: string]: ReadonlyArray<unknown> };
    readonly liquidationsBySymbol: { readonly [k: string]: ReadonlyArray<unknown> };
    readonly rowsBySymbol?: { readonly [k: string]: ReadonlyArray<unknown> };
  };
```

- [ ] **Step 4: Filter `rowsBySymbol` in `filterBundleToSymbols`**

In `filterBundleToSymbols`, the `historical` object is built with `pickSyms(...)` for each map. Add a
conditional `rowsBySymbol` entry inside that object literal, after `liquidationsBySymbol`:

```ts
        liquidationsBySymbol: pickSyms(
          Object.fromEntries(Object.entries(h.liquidationsBySymbol).map(([k, v]) => [k, [...v]])),
          syms,
        ),
        ...(h.rowsBySymbol !== undefined
          ? {
              rowsBySymbol: pickSyms(
                Object.fromEntries(Object.entries(h.rowsBySymbol).map(([k, v]) => [k, [...v]])),
                syms,
              ),
            }
          : {}),
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test -- test/scripts/make-fixture.test.ts`
Expected: PASS (existing cases + the new `rowsBySymbol` case).

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/make-fixture.ts test/scripts/make-fixture.test.ts
git commit -m "feat(make-fixture): carry historical.rowsBySymbol through the symbol filter"
```

---

### Task 4: READ-surface regression guard — `readRows` surfaces taker from `rowsBySymbol`

**Files:**
- Test: `test/snapshot/readers/rows-taker.test.ts` (create)

**Interfaces:**
- Consumes: `readRows(bundle, { symbol })` from `src/snapshot/readers/rows.ts`; `CanonicalRowV2` from `src/contract/historical-read/dto.js`.
- Produces: nothing (guard test).

This task adds no production code — `readRows` already prefers `hist.rowsBySymbol?.[symbol]`. The test
locks in that a rows-bearing bundle returns taker verbatim and that the synth fallback still reports no taker.

- [ ] **Step 1: Write the test**

Create `test/snapshot/readers/rows-taker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readRows } from '../../../src/snapshot/readers/rows.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../../src/contract/historical-read/dto.js';

const takerRow: CanonicalRowV2 = {
  schema_version: 2,
  minute_ts: 1_781_220_000_000,
  symbol: 'ESPORTSUSDT',
  open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, turnover: 150,
  oi_total_usd: null, funding_rate: null, liq_long_usd: null, liq_short_usd: null,
  has_oi: false, has_funding: false, has_liquidations: false,
  taker_buy_volume_usd: 600, taker_sell_volume_usd: 400, has_taker_flow: true,
};

describe('readRows + taker', () => {
  it('returns rowsBySymbol verbatim including taker when present', () => {
    const bundle = { historical: { rowsBySymbol: { ESPORTSUSDT: [takerRow] } } } as unknown as SnapshotBundle;
    const out = readRows(bundle, { symbol: 'ESPORTSUSDT' });
    expect(out).toHaveLength(1);
    expect(out[0]!.has_taker_flow).toBe(true);
    expect(out[0]!.taker_buy_volume_usd).toBe(600);
    expect(out[0]!.taker_sell_volume_usd).toBe(400);
  });

  it('synth fallback (no rowsBySymbol) reports has_taker_flow=false', () => {
    const bundle = {
      historical: {
        barsBySymbolAndTimeframe: { ESPORTSUSDT: { '1h': [{ tsMs: 1_781_220_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }] } },
        fundingBySymbol: {}, openInterestBySymbol: {}, liquidationsBySymbol: {},
      },
    } as unknown as SnapshotBundle;
    const out = readRows(bundle, { symbol: 'ESPORTSUSDT' });
    expect(out).toHaveLength(1);
    expect(out[0]!.has_taker_flow).toBe(false);
    expect(out[0]!.taker_buy_volume_usd).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test -- test/snapshot/readers/rows-taker.test.ts`
Expected: PASS (both cases — `readRows` already supports the preference + synth fallback).

> If the second case fails because `synthesizeRowsFromPerKind` requires a finest-timeframe lookup that
> rejects the minimal bar, adjust the bar's timeframe key to `'1h'` (already used) — do not change production code.

- [ ] **Step 3: Commit**

```bash
git add test/snapshot/readers/rows-taker.test.ts
git commit -m "test(historical): guard taker pass-through via rowsBySymbol in readRows"
```

---

### Task 5: Document taker/CVD consumption + owner fetch runbook

**Files:**
- Modify: `docs/contracts/snapshot-format.md` (append a "Taker flow & CVD" subsection)

**Interfaces:**
- Consumes: nothing. Produces: docs only.

- [ ] **Step 1: Append the docs subsection**

Add to the end of `docs/contracts/snapshot-format.md`:

```markdown
## Taker flow & CVD (feature 028)

Fresh snapshots fetched over a post-028 window carry per-minute taker flow inside
`historical.rowsBySymbol` (`CanonicalRowV2`): `taker_buy_volume_usd`,
`taker_sell_volume_usd`, and `has_taker_flow`. These are raw cross-source SUM quote
volumes; `has_taker_flow=false` ⇒ both volumes are `null` (missing, distinct from a
present zero). Older (pre-028) snapshots have no `rowsBySymbol`; the READ surface
synthesizes rows from the per-kind series with taker `null` / `has_taker_flow=false`.

**CVD is not stored.** Mirroring the platform canon, cumulative volume delta is derived
downstream from raw taker (`cvd = Σ(taker_buy - taker_sell)` over the window). The lab
computes it on read; the mock never persists a CVD column.

### Owner runbook — produce a taker-bearing demo fixture

Run from a host with VPS access (authoring-side; the VPS snapshot stays gitignored):

    pnpm fetch:snapshot --vps <user@host> --db-url <...> --parquet-root <...> \
      --from <YYYY-MM-DD> --to <YYYY-MM-DD> --ref <YYYY-MM-DD>-vps
    pnpm make:fixture -- --source data/snapshots/<YYYY-MM-DD>-vps \
      --out data/snapshots/fixtures/<YYYY-MM-DD>-real-top5 --top 5

Pick a window where the platform's `schema_version=2/` parquet carries taker (post-028
go-live). Real losing trades arrive naturally from the source (~72% win rate); no
synthetic seeding. Commit the new fixture; leave `fixtures/2026-06-12-real-top5` untouched.
```

- [ ] **Step 2: Commit**

```bash
git add docs/contracts/snapshot-format.md
git commit -m "docs(snapshot): document taker-flow rows, lab-derived CVD, and fetch runbook"
```

---

### Final verification

- [ ] **Run the full gate**

Run: `pnpm check:ci`
Expected: PASS — typecheck clean, all vitest suites green, contract-isolation / no-forbidden-deps / no-secrets / vendored-sdk / harness-sync all pass.

- [ ] **Confirm no scope leakage**

Run: `git diff --stat main...HEAD`
Expected: only `tools/fetch-snapshot/fetch-snapshot.ts`, `scripts/make-fixture.ts`, the four test files, and `docs/contracts/snapshot-format.md` — plus the spec/plan docs. No changes under `src/contract/**` (the contract already models taker), no new dependencies in `package.json`.

---

## Notes for the implementer

- The actual VPS fetch and committing the new fixture are **owner-run** (no VPS access here) and are
  intentionally NOT plan tasks — Task 5 documents the runbook. The code in Tasks 1–4 is what makes that
  fetch capture taker; a fresh `pnpm fetch:snapshot` over a post-028 window then yields a fixture whose
  `loadSnapshot` validates `rowsBySymbol` against `canonicalRowV2` and whose historical rows handler
  exposes `has_taker_flow:true` rows. The existing `loadSnapshot`/AJV path needs no change.
- Do not invent a `cvd` field. Do not touch `src/contract/**`. Do not add runtime dependencies.
