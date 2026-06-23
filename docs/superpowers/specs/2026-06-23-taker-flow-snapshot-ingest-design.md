# 2026-06-23 — Capture taker-flow (028) in fresh snapshots → richer, loss-bearing demo fixture — design

## Problem

The committed demo fixture (`fixtures/2026-06-12-real-top5`) was reported as "having no
losing trades". Investigation showed that is not literally true — it carries **15 losing
trades out of 73** (`isWin:false`, real negative `realizedPnl`) — but its win rate is an
unrealistically high **79%**, because the top-5-by-trade-count selection skewed toward the
luckier symbols. The real source snapshot `2026-06-12-vps` has the full picture: **110
trades, 31 real losses, 71.8% win rate** across 31 symbols.

The deeper goal is hypothesis testing in the lab ("improve results"), which needs the
historical **funding / taker-flow** features that the live platform began recording. The
owner's framing: "look at trades after 12 June — that's when funding, CVD and taker started
being written into historical data."

Mapping that to the source of truth in the private `trading-platform`:

- **funding_rate** — feature 027 (live-forward), already ingested.
- **taker buy/sell** — feature **028 (raw-taker-flow)**: canonical row bumped v1→v2
  (`schema_version=2/` parquet sub-tree) adding `taker_buy_volume_usd`,
  `taker_sell_volume_usd`, `has_taker_flow`. Strictly additive; v1 partitions frozen.
- **CVD** — **not a stored column.** Per the canon (`src/contracts/historical/canonical-row.ts`):
  "delta выводится из buy/sell (не колонка); cumulative-агрегаты не хранятся." CVD is
  derived downstream from taker buy/sell (`deriveCvdFromTakerWindow`).

So "funding, CVD, taker" = **funding_rate + raw taker buy/sell**, with CVD derived.

## Root cause (what is actually missing)

The mock's READ surface and contract **already fully model taker**:

- `src/contract/snapshot/schema.ts` → `canonicalRowV2` has the 19 fields incl.
  `taker_buy_volume_usd` / `taker_sell_volume_usd` / `has_taker_flow`; `historicalBundle`
  has optional `rowsBySymbol: canonicalRowV2[]`. Matches the platform canon exactly (SDK-sourced).
- `src/historical/handlers/rows.ts` / `src/snapshot/readers/rows.ts` surface canonical rows;
  when `rowsBySymbol` is present it is returned directly (taker included).

The gap is entirely on **INGEST** (and one pass-through in the fixture authoring tool):

1. `tools/fetch-snapshot/fetch-snapshot.ts` `readParquetDir` already walks both
   `schema_version=1` and `=2` part-files, but for `sv===2` it requests an **identical column
   list to v1** — the `taker_*` columns are never read. `MinuteRow` has no taker fields, so
   taker is silently dropped even when present in the parquet.
2. `aggregateHistorical` emits only per-kind series (bars / funding / OI / liquidations);
   it never emits `rowsBySymbol`, so there is no carrier for taker.
3. `synthesizeRowsFromPerKind` (the READ fallback when `rowsBySymbol` is absent) sets
   `taker_*: null`, `has_taker_flow: false` by construction — per-kind series have no taker.
4. `scripts/make-fixture.ts` `filterBundleToSymbols` rebuilds `historical` from the 4 per-kind
   maps + bars only; a `rowsBySymbol` map would be **dropped** during fixture subsetting.

## Decisions (locked)

- **Representation:** carry taker via **`rowsBySymbol` (full CanonicalRowV2, per-minute)** —
  matches the canonical storage unit, the READ path already prefers rows, no new schema field
  needed. Per-kind series (bars + funding/OI/liq) stay as-is for backward compat. Accepts the
  size cost (full per-minute fidelity was already accepted for this fixture family).
- **CVD:** **not stored** in the mock bundle. Surface only raw taker buy/sell; the lab derives
  CVD (cumsum of buy−sell), mirroring the platform's `deriveCvdFromTakerWindow`. Matches canon.
- **Fixture:** produce a **new dated fixture** (e.g. `fixtures/2026-06-2x-real-top5`) from the
  fresh fetch; leave `fixtures/2026-06-12-real-top5` untouched. Real losing trades arrive
  naturally from the source (~72% win rate); no synthetic seeding.

## Components

### 1. `fetch-snapshot` ingest (authoring-side, reads VPS parquet)

- `MinuteRow`: add `takerBuy: number | null`, `takerSell: number | null` (v1 parts → null).
- `readParquetDir`: for `sv===2` parts add `'taker_buy_volume_usd'`, `'taker_sell_volume_usd'`
  to `columns`; populate the new `MinuteRow` fields via the existing `toNumOrNull`.
- `HistoricalBundle` (tool-local interface): add `rowsBySymbol: Record<string, CanonicalRowV2[]>`.
- `aggregateHistorical`: in addition to the existing per-kind/bars aggregation, emit one
  `CanonicalRowV2` **per source minute** per symbol:
  - `schema_version: 2`, `minute_ts: r.ts`, `symbol`, OHLCV from the minute row,
    `turnover: volume * close`.
  - `oi_total_usd`/`funding_rate`/`liq_long_usd`/`liq_short_usd` + their `has_*` from the
    minute row (null ⇒ has_*=false).
  - `taker_buy_volume_usd: r.takerBuy`, `taker_sell_volume_usd: r.takerSell`,
    `has_taker_flow: r.takerBuy !== null || r.takerSell !== null`.
  - Rows sorted ascending by `minute_ts`, deduped per minute (last-wins, mirroring funding dedup).
- `buildBundle` already passes `historical` through verbatim — no change.
- Validation: the full bundle must still pass `assertValidBundle`; `rowsBySymbol` items must
  satisfy `canonicalRowV2` (`additionalProperties:false`, all 19 required keys present).

### 2. `make-fixture` pass-through

- `BundleLike.historical` / `RawHistorical`: add optional `rowsBySymbol`.
- `filterBundleToSymbols`: when `historical.rowsBySymbol` is present, include
  `rowsBySymbol: pickSyms(rowsBySymbol, syms)` in the rebuilt historical object.
- `normalizeHistorical` is unaffected (it only touches OI/liq field-name bridging); rows from a
  v2 fetch are already canonical-shaped.

### 3. READ surface — no change

`readRows` already returns `rowsBySymbol` when present; `synthesizeRowsFromPerKind` stays the
fallback for older (rows-absent) fixtures. Confirm via test that a rows-bearing fixture surfaces
`has_taker_flow:true` rows unchanged through the historical rows handler.

### 4. CVD — lab-side (out of scope for this repo)

No mock code stores or derives CVD. A short doc note points the lab at the raw taker fields and
the canonical derivation (cumsum buy−sell). No new contract field.

## What the owner runs (not automatable here — no VPS access)

```
pnpm fetch:snapshot --vps <user@host> --db-url <...> --parquet-root <...> \
  --from 2026-06-2x --to 2026-06-2y --ref 2026-06-2x-vps
pnpm make:fixture -- --source data/snapshots/2026-06-2x-vps \
  --out data/snapshots/fixtures/2026-06-2x-real-top5 --top 5
```

The window must be one where the platform's `schema_version=2/` parquet carries taker (post-028
go-live). The fresh fixture is the committed deliverable; the VPS snapshot stays gitignored.

## Testing

- `aggregateHistorical` unit test: given minute rows with taker on v2 + a v1 minute (taker null),
  emits `rowsBySymbol` with correct `has_taker_flow` / null handling and per-minute OHLCV/turnover.
- `readParquetDir` column-selection: v2 parts request the taker columns (guard the regression).
- `filterBundleToSymbols`: `rowsBySymbol` is subset to the kept symbols and survives.
- A rows-bearing fixture loaded through `loadSnapshot` validates against `canonicalRowV2` and the
  historical rows handler returns `has_taker_flow:true` rows verbatim.
- `pnpm check:ci`, `pnpm verify:no-secrets`, `pnpm verify:contract-isolation`,
  `pnpm verify:no-forbidden-deps` stay green (no new runtime deps; `pg`/`ccxt` still forbidden).

## Out of scope

- The actual VPS fetch and new-fixture commit (owner-run; needs VPS + post-028 window).
- Storing or computing CVD in the mock.
- Synthetic trade seeding (rejected — real losses exist in source).
- Touching `fixtures/2026-06-12-real-top5` or the synthetic fixture.
- Any per-exchange / derived historical field (forbidden by canon).

## Success criteria

A fresh `fetch:snapshot` over a post-028 window produces a bundle whose `historical.rowsBySymbol`
carries real `taker_buy_volume_usd` / `taker_sell_volume_usd` (`has_taker_flow:true`), `make-fixture`
subsets it losslessly into a new committed fixture that loads + validates, the historical rows READ
surface exposes taker, the demo dataset shows a realistic win rate from real losing trades, and all
repo gates stay green — no private-platform import, no stored CVD.
