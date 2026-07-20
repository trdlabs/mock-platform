# Spec: WFO extended fixture — mock-platform half (items 1, 3, 5)

**Date:** 2026-07-21
**Initiative:** control-center `wfo-extended-fixture`
**Scope of this spec:** the `trading-mock-platform` items only — **3** (fixture
integrity/coverage validator), **1** (fetch + commit the 42-day T2 fixture), **5**
(code-default `MOCK_SNAPSHOT_REF` fix).

**Out of scope** (separate rollout via control-center SSOT): item 2 (SSOT tier
table), item 4 (lab/backtester consumer selection), item 6 (docs). This spec does
**not** change `ecosystem-defaults.yaml`, lab/office env, or embed T2 into the demo
image.

## Constraints (operator-set)

- The VPS fetch is **read-only**: `SELECT`/parquet reads only, no writes to the VPS.
- **No secrets printed** to logs or committed.
- The T2 fixture is committed **only after** the integrity/coverage validator passes
  in enforce mode.
- Budgets are **frozen before** the VPS probe and are never tuned to fit the data
  found. If a conforming window cannot be obtained, **stop and report a blocker** —
  do not substitute synthetic data.
- Delivery order (forced by the above): **item 3 before item 1** — the validator gate
  must exist before the T2 bundle is admitted through it.

---

## §1. Item 3 — fixture integrity / coverage validator

### 1.1 Sidecar, not a schema change

Adding a field under the manifest's `additionalProperties:false` schema would make an
old reader reject the new manifest — that is **not** additive. Instead the declared
coverage lives in a **sidecar** file next to the manifest, read **only** by the CI
validator. `snapshot.1`, `src/contract/snapshot/schema.ts`, `manifest.ts`,
`src/snapshot/loader.ts`, and `compat.ts` are **untouched**. The loader reads a fixed
set of files (`manifest.json`, `checksums.json`, the bundle); an extra
`coverage.json` in the directory is ignored by the runtime entirely.

```
data/snapshots/wfo/<ref>/coverage.json      # declared; read ONLY by verify_fixtures.ts
```

```jsonc
{
  "schemaVersion": "fixture-coverage.1",
  "period":  { "fromMs": <int>, "toMs": <int> },   // half-open, both % 60000 == 0
  "symbols": ["HUSDT", "...", "...", "...", "..."], // exactly the native-1m symbols
  "totalGapBudgetMinutes":    6480,                 // 37.5d net over a 42d window
  "maxConsecutiveGapMinutes": 1440                  // no single blackout longer than 1 day
}
```

**Strict AJV schema for the sidecar** (`fixture-coverage.1`):
`additionalProperties: false`; `period.fromMs`/`period.toMs` integers, `% 60000 == 0`,
`toMs > fromMs`; `symbols` exactly **5** unique strings; both budgets **non-negative
integers**. A malformed sidecar is a hard `FAIL` (not a warn).

The sidecar is not covered by `checksums.json` (which hashes the bundle). That is
acceptable: the only way to weaken the gate via the sidecar is to declare a smaller
window or a looser budget, and that change is visible and reviewable in the committed
`coverage.json` diff.

### 1.2 Anti-tautology invariant

`declared` and `actual` are produced by **different actors, in different files**, and
the comparison is never allowed to become trivially true:

- **declared** — the whole `coverage.json` — is written from the *fetch intent* (the
  chosen window, the 5 symbol names, the frozen budgets). It is **never** derived from
  bundle content. `fetch-snapshot` and `make-fixture` MUST NOT populate these values
  from what they read; the authoring tool (`make-wfo-fixture.ts`, §2.4) takes them as
  **required CLI flags**.
- **actual** — computed **only** by `verify_fixtures.ts` from `rowsBySymbol`. The
  validator only reads and compares; it never writes.

### 1.3 Gap-budget semantics (exact)

For a half-open window `[fromMs, toMs)`, expected minute count
`E = (toMs − fromMs) / 60000`.

**Unified minute grid.** The invariant is that the `minute_ts` set is **identical**
across all 5 symbols; `G` is that common set (achieved by construction at fetch time,
§2.3, and *verified* here in the committed artifact to defend against drift or hand
edits). Because the grid is shared, `present = |G|` is a single number, and every
grid point in `G` is guaranteed to carry all 5 symbols — which is exactly what
multi-symbol WFO needs.

Two **independent** limits, both applied to `G` inside the window:

- **Total gap:** `E − |G| ≤ totalGapBudgetMinutes`.
- **Max consecutive gap:** the longest **contiguous** run of missing minutes
  `≤ maxConsecutiveGapMinutes`. Window edges count as runs:
  - leading run `= (G[0] − fromMs) / 60000`
  - trailing run `= (toMs − 60000 − G[last]) / 60000`
  - internal run between adjacent `G[i] < G[i+1]` `= (G[i+1] − G[i]) / 60000 − 1`

`totalGapBudgetMinutes = 6480` encodes "≥ 37.5 days of data in a 42-day window"
(`E = 60480`, floor `54000`). `maxConsecutiveGapMinutes = 1440` means a single
one-day blackout is tolerated but nothing longer. Both are stored as **concrete
integers** in the sidecar; the "37.5d / 1 day" rationale lives only in this spec, not
in code.

### 1.4 Corruption gate — no silent normalization

`present = |G|` is only meaningful once the rows are known clean. Before computing
`G`, the validator **fails separately** (distinct diagnostic per case) on, for each
declared symbol's `rowsBySymbol[sym]`:

- any `minute_ts % 60000 != 0` (misaligned),
- any duplicate `(symbol, minute_ts)`,
- any violation of strict ascending `minute_ts` order.

The validator is self-contained — it does not assume the loader or bundle schema
already guarantees these.

### 1.5 Check order (fail-safe)

Structural validity is checked **before** touching row data, so a missing declared
symbol yields a clean diagnostic `FAIL` rather than a technical exception:

1. **sidecar schema** (`fixture-coverage.1`, AJV) valid;
2. **symbols set**: `sorted(declared.symbols) == sorted(keys(rowsBySymbol))` — exact
   equality; and each declared symbol's `rowsBySymbol[sym]` is **present and non-empty**.
   A bars-only fixture (no `rowsBySymbol` keys) that declares coverage fails here;
3. **corruption gate** (§1.4) per symbol;
4. **unified grid**: `minute_ts` sets identical across all 5 → `G`;
5. **window containment**: every `g ∈ G` is in `[fromMs, toMs)`;
6. **total gap** ≤ `totalGapBudgetMinutes`;
7. **max consecutive gap** (edge-inclusive) ≤ `maxConsecutiveGapMinutes`.

Any failed step → non-zero exit with a specific message.

### 1.6 Warn / enforce policy and scan roots

- A fixture directory **with** `coverage.json` → **enforce**: any deviation is a
  non-zero exit.
- A fixture directory **without** `coverage.json` (the 5 legacy fixtures + golden) →
  one `WARN (legacy — no declared coverage)` line, exit 0.

`verify_fixtures.ts` scans **exactly two explicit roots** —
`data/snapshots/fixtures/*` and `data/snapshots/wfo/*` — **not** `data/snapshots/**`,
so it never picks up temporary or raw VPS refs left elsewhere under `data/snapshots/`.

**Placement:** new `scripts/verify_fixtures.ts`, added to `check:ci` after
`verify:no-secrets`. Pure comparator functions are unit-tested (§4).

---

## §2. Item 1 — fetch + commit the 42-day T2 fixture

Five steps; no VPS write; the fixture is committed only at the end, only if green.

### 2.1 Deterministic symbol ranking (frozen ahead of the probe)

- **Primary:** `HUSDT` (SSOT primary), always included.
- **Top-4 by liquidity:** ranked by summed 1m turnover (`CanonicalRowV2.turnover`
  over every minute of the window) over the **same 48–50 day VPS window** used for the
  raw pull, computed **excluding HUSDT**; ties broken by `symbol ASC`.
- The ranking source is a VPS aggregate. If that aggregate is **unavailable**, this is
  a **blocker** — do **not** fall back to ranking from the committed 7-day slice at
  execution time (that would make selection non-deterministic).
- Final set = `HUSDT` + the 4 ranked symbols. All five are recorded in provenance.

### 2.2 Read-only pull (one VPS visit)

Pull raw native-1m historical for the **5 selected symbols** over a *generous* window
(the latest ~48–50 days) into a **local temporary** ref under `data/snapshots/` that is
**not committed** and lives outside the two validator scan roots. This gives slack for
choosing the 42-day anchor offline without further VPS round-trips.

### 2.3 Window selection + intersection (local, offline)

- **Window:** span is **exactly 42 days**; the only freedom is the anchor.
  `toMs = start_of(latest_complete_UTC_day + 1)`, `fromMs = toMs − 42·86400·1000`.
  Slide the anchor from the freshest day backwards to the first whose **intersected
  grid** passes **both** frozen budgets (§1.3) for all 5 symbols. First match wins;
  none → **blocker**.
- **Intersection:** `rowsBySymbol[sym]` is filtered to the common grid
  `G = ⋂ minute_ts` within `[fromMs, toMs)`, for all 5 symbols. The grid invariant
  then holds by construction.
- **Bars:** `barsBySymbolAndTimeframe` (1h/1d) for the 5 symbols is **also filtered to
  `[fromMs, toMs)`**. Otherwise a fixture declaring a 42-day coverage window would leak
  data outside it through the bars surface.

### 2.4 Authoring — sidecars from intent (local)

New `scripts/make-wfo-fixture.ts` reads the raw local source fixture and produces the
aligned committed fixture. It takes as **required flags**: `--symbols`, `--from`,
`--to`, `--total-gap-budget`, `--max-consecutive-gap`. It:

- writes the aligned bundle via the existing `writeSnapshot` path (manifest +
  checksums, gzip when raw > 90 MiB — expected here);
- writes `coverage.json` **from those flags** — never from the produced bundle (this is
  the §1.2 invariant made structural);
- writes `provenance.json` (§2.5).

### 2.5 Provenance (`provenance.json`, descriptive sidecar, not a gate input)

Records enough to reproduce the selection and trimming and to distinguish
"absent on the VPS" from "intentional trimming":

- note: rows filtered to the intersection of the 5 source series;
- per symbol: `sourceRows` → `finalRows`;
- `|G|` (common grid size) and the chosen `[fromMs, toMs)`;
- the ranking source and the **tie-break algorithm** (`top-4 by summed 1m turnover,
  excl. HUSDT, ties by symbol ASC`);
- the **raw source ref** and the **sha256 of its raw (pre-gzip) bundle bytes**.

### 2.6 Validate → commit

`verify:fixtures` in enforce mode on the T2 fixture must be **green**; `pnpm check:ci`
green. Only then commit: bundle + `manifest.json` + `checksums.json` + `coverage.json`
+ `provenance.json`, at `data/snapshots/wfo/<from>-to-<to>-vps-wfo42d/`.

### 2.7 Where T2 lives — image stays unchanged

The Dockerfile does `COPY data/snapshots/fixtures` only, so committing T2 under
`data/snapshots/wfo/` keeps the demo image byte-for-byte unchanged (the card's
"default image does not grow" acceptance gate). The ref is `wfo/<...>-vps-wfo42d`,
resolved relative to `MOCK_SNAPSHOT_DIR` (`./data/snapshots`). Embedding T2 into an
image is deferred to the separate rollout (card rollout step 4).

---

## §3. Item 5 — code-default `MOCK_SNAPSHOT_REF` (independent)

- `src/access/config.ts:34`: default `'fixtures/2026-06-16-synthetic'` →
  `'fixtures/2026-06-22-to-2026-06-28-vps'` — the **T1 SSOT default** (native 1m, 26
  symbols), **not** T2. This aligns the hardcoded fallback with the already-established
  SSOT default; it does not change `ecosystem-defaults.yaml`.
- mock `.env.example`: same swap.
- **Verify at implementation:** any test that builds config with empty env and relies
  on the synthetic/bars-only default; the README note from `mock-contract-parity`
  ("starting without an explicit ref yields `minute_rows_unavailable`") becomes false
  and must be updated.
- **Cost:** `pnpm dev` / Docker with no env now loads the 21 MB gz T1 fixture (already
  in the image) into RAM instead of the 32 KB synthetic one — which is the point:
  removing the bars-only-default footgun.

---

## §4. Testing and gates

- **Unit test** for `verify_fixtures.ts` (pure comparator), modelled on
  `test/scripts/no-forbidden-deps.test.ts` — happy path **and every fail mode**:
  malformed sidecar schema, symbol-set mismatch, missing/empty symbol, bars-only,
  duplicate `minute_ts`, misaligned `minute_ts`, non-strict-increasing, non-identical
  grids, total-gap over budget, consecutive-gap over budget, edge-gap over budget.
- **Runtime smoke:** `openSnapshot(rootDir, "wfo/<ref>")` resolves and loads the T2
  fixture — proving the nested ref addresses locally.
- **Docker check (inverse):** the built image does **not** contain the T2 fixture and
  its size is unchanged versus `origin/main`.
- **CI:** `verify:fixtures` runs in `check:ci`; legacy fixtures WARN (exit 0), T2
  enforces green. Full `pnpm check:ci` green.

## §5. Error handling / stop conditions

- VPS ranking aggregate unavailable → **blocker**, stop (no proxy fallback).
- No 42-day anchor passes both budgets for all 5 symbols → **blocker**, stop (no budget
  tuning, no synthetic substitution).
- Validator FAIL on the produced T2 → do **not** commit; investigate and re-run.

## §6. Non-goals

No manifest schema / loader / compat changes. No `snapshot.2`. No ecosystem-default,
lab/office env, SSOT tier table, or consumer-selection changes. No embedding of T2 in
any image. No changes to the 5 legacy fixtures (they stay coverage-less and WARN).

## §7. Rollback

- Item 3: drop `verify:fixtures` from `check:ci`, or leave it (legacy fixtures WARN, so
  it is a no-op without a `coverage.json`). Self-contained.
- Item 1: remove the `data/snapshots/wfo/<ref>/` directory; nothing runtime depends on
  it (selection is explicit and out of scope here).
- Item 5: revert the two one-line default swaps; independent of items 1/3.
