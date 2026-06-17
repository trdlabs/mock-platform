# Feature 004 — Lift live bot-results contract into `@trading-platform/sdk` (A2.5 → A3)

- **Date:** 2026-06-17
- **Branch:** `004-sdk-live-contract-lift`
- **Repos:** `trading-platform` (SDK side) + `trading-mock-platform` (consumer side) — one shared plan, sequential.
- **Status:** design approved; plan pending.

## 1. Goal

Make `@trading-platform/sdk` the **source of truth** for the live bot-results contract primitives, and switch the mock from *declaring* those types to *importing* them from the SDK via a vendored tarball. This is a conscious doctrine move from **A2.5** (mock-owned, isolated contract layer) to **A3** (shared contract lives in the SDK as source of truth).

This is a **contract-first increment**: we lift only the already-existing live bot-results primitives. We do not redesign the architecture, do not touch trading-lab, do not touch the backtest surface, and do not implement or fake backtesting.

### Established facts (do not re-open)

- `trading-lab` reads results through `@trading-platform/sdk/agent/`; `getRunResult` = **backtest**, not live.
- The agent SDK today declares `live: false`, `rawStorage: false` (machine-checked literals) — there is **no** live bot-results surface in the SDK.
- The live bot-results contract is currently duplicated:
  - `trading-platform/src/operations/dto.ts` — de-facto source of truth (feature "ops-read 033").
  - `trading-mock-platform/src/contract/ops-read/dto.ts` — field-for-field hand copy.
  - SDK — absent.

### Correction to the original framing (grounded in cross-repo exploration)

- The hand copy of `operations/dto.ts` is the mock's **`src/contract/ops-read/dto.ts`** (ops surface), **not** `research-read/dto.ts`.
- `research-read/dto.ts` (`ResearchRunResult`, `ResearchTrade`, `ResearchMetrics`, …) is a **mock-invented research projection** with no counterpart in `operations/dto.ts` or the SDK. It is **out of scope** here and **must stay** mock-owned, dependency-free, and extractable.
- Platform type names: `BotRunRecord` (not `BotRun`), `DecisionLogEntry` (not `DecisionLog`). There is **no `equityCurve` type** anywhere — `equity-curve` exists only as a backtest `ArtifactType` string literal.
- The mock does **not** vendor the SDK today — this is its **first** vendoring. (The sibling `trading-lab` repo is the one that already vendors the SDK tarball; not the mock.)

## 2. Six approved decisions

1. **What we lift / which layer consumes it.** Lift the live bot-results **primitives** from `operations/dto.ts` into the SDK; switch the mock's **`ops-read/dto.ts`** to import them. `research-read/dto.ts` is untouched this feature.
2. **SDK surface + version axis.** New dedicated subpath **`@trading-platform/sdk/ops-read`** (parallel to `/agent`), **types-only**, **own-declared** in the SDK — hand-authored under `packages/sdk/src/ops-read/`, mirroring the feature-036 intake precedent (`PaperCandidateReadView`). Equivalence to `operations/dto.ts` is **machine-guaranteed** by a **new conformance fixture** (`Mutual<Sdk.X, Plat.X>` mutual-assignability, compiled against `dist/src/operations/dto.js` by a `tsc --noEmit` gate). The SDK stays standalone — the fixture lives **outside** `packages/sdk/src`, so it never leaks into the published surface, and **`gen_sdk_snapshot.mjs` is not touched** (its drift gate only confirms 'no drift'). Its **own** `OPS_READ_CONTRACT_VERSION` axis (value `'ops.3'`, matching the platform). Backtest `CONTRACT_VERSION='017.2'` is **not** touched. `SDK_CAPABILITIES.live` stays **`false`** (these are read-only result types, not live connectivity).

   > **Mechanism note (refinement, 2026-06-17):** an earlier draft of this decision said "generated-vendored via `gen_sdk_snapshot`." Deeper cross-repo research showed `gen_sdk_snapshot` is a whitelist-copy engine purpose-built for the research contract (`017.x`) and that the closest precedent for a types-only SDK surface (036) hand-authors its DTOs and proves them via a conformance fixture. The mechanism was changed to **own-declared + conformance**; the invariant (SDK = source of truth, standalone, conformance-proven against `operations/dto.ts`, drift impossible) is preserved. "Duplicate types in the SDK" does not violate the feature goal — the goal is to remove *uncontrolled* drift, and the mutual-assignability gate makes drift CI-visible and impossible to merge.
3. **Isolation / A3.** `src/contract/ops-read/dto.sdk.ts` re-exports the SDK ops-read core; `verify_contract_isolation` is narrowed (see §4) to permit exactly `@trading-platform/sdk` and **only** in that one file. This is the literal A3 statement: the contract layer sources its live primitives from the SDK. Future-flag: if the entire contract layer is ever extracted into a neutral `@trading/contracts` repo that must not depend on the SDK, revisit and move the re-export outside the contract layer.
4. **Versioning.** SDK is source of truth for `OPS_READ_CONTRACT_VERSION`; the mock **imports** it from the SDK (stops declaring its own) and keeps the existing fail-closed **exact-match** check in `compat.ts`. The vendored tgz is **exact-version pinned** (filename + specifier); a new mock verify step asserts the vendored tgz matches the specifier and its embedded `OPS_READ_CONTRACT_VERSION` equals what the mock expects. tgz update = documented operator runbook. If the SDK value differs from the current `'ops.3'`, fixtures/manifests are realigned to the SDK value (explicit contract decision recorded in the plan).
5. **Scope of the lift.** **Only** the bot-results core: `BotRunRecord`, `ClosedTrade`, `ClosedTradesAggregate`, `RunSummary`, `OperationalEvent`, `DecisionLogEntry` + the closed unions `BotMode`, `BotRunStatus`, `TradeSide`, `OpsSeverity`, `BotRunStrategyRef`. Health / coverage / discover / page-envelope types stay mock-local; their lift is a separate future fork.
6. **Hybrid file split** (makes the phase boundary explicit, not hidden debt):
   - `src/contract/ops-read/dto.sdk.ts` — re-export of the bot-results core from `@trading-platform/sdk/ops-read`.
   - `src/contract/ops-read/dto.local.ts` — health / coverage / discover / page-envelope, mock-local until a future lift.
   - `src/contract/ops-read/dto.ts` — barrel re-exporting both → **zero churn** for the ~5 consumers (import path `../ops-read/dto.js` unchanged).

## 3. Architecture (cross-repo)

```
trading-platform                                  trading-mock-platform
  src/operations/dto.ts  ──(hand-author)──►  packages/sdk/src/ops-read/   ──npm pack──►  vendor/…sdk-0.3.0.tgz
  (source of truth)                            (new subpath, types-only,                       │
        ▲                                       own OPS_READ_CONTRACT_VERSION)                 ▼
        │ Mutual<Sdk,Plat> conformance fixture                              src/contract/ops-read/dto.sdk.ts
        └──  (conformance/ops-read-dto.conformance.ts,                       (re-export of SDK core; ONLY file
              outside packages/sdk/src — proves equivalence)                  allowed to import the SDK)
                                                                                 │
                                                          dto.ts (barrel) ◄──────┴────── dto.local.ts (health/coverage,
                                                             │                              mock-local)
                                             ~5 consumers (bundle.ts, handlers, readers) — import path unchanged
```

A3 framing: the mock's contract layer **points at the SDK** as the neutral home of platform contracts. `research-read/dto.ts` (mock-owned projection) stays clean and dependency-free, **machine-guaranteed** by the sub-directory-scoped isolation rule.

## 4. Components & changes

### 4.1 SDK side (`trading-platform`, step 1)

- New export subpath `@trading-platform/sdk/ops-read`, **types-only**, **hand-authored** under `packages/sdk/src/ops-read/{dto.ts,version.ts,index.ts}` with the bot-results core (decision 5) declared verbatim from `operations/dto.ts` (no platform import — the types are primitive/closed-union only).
- **`gen_sdk_snapshot.mjs` is not touched** (mirrors the 036 intake precedent, which hand-authors its DTOs rather than vendoring them). The generator's drift gate (`gen:sdk-snapshot:check`) continues to confirm 'no drift' and stays green.
- `OPS_READ_CONTRACT_VERSION = 'ops.3'` declared in `packages/sdk/src/ops-read/version.ts` as a distinct version axis. Backtest `CONTRACT_VERSION='017.2'` unchanged → `verify_032/034_zero_bump` (and the ops `verify_033/035_zero_bump`) stay green.
- `SDK_CAPABILITIES.live` / `rawStorage` stay `false` → `verify_032/034_capability_absence` stay green.
- **New conformance fixture** `packages/sdk/conformance/ops-read-dto.conformance.ts` (+ `tsconfig.ops-read.json`): mutual-assignability `Mutual<Sdk.X, PlatOps.X>` for every lifted type, compiled `tsc --noEmit` against `dist/src/operations/dto.js` — the exact pattern of `paper-candidate.conformance.ts` (036). A new `verify_033_sdk_ops_read_conformance.mjs` (modeled on `verify_036_type_conformance.mjs`) runs it and is appended to the `gates:033` aggregate.

### 4.2 Mock side (`trading-mock-platform`, step 2)

- **Vendor tgz:** `npm pack` the SDK → place `vendor/trading-platform-sdk-<v>.tgz`; `package.json` references it with a `file:` specifier; add to `dependencies`.
- **Three-file split** of `src/contract/ops-read/` per decision 6.
- **Version:** mock imports `OPS_READ_CONTRACT_VERSION` from the SDK; `src/contract/ops-read/version.ts` stops declaring its own constant; `compat.ts` keeps its exact-match assertion against the manifest. If the SDK value ≠ `'ops.3'`, realign fixtures + manifests (recorded explicitly).

### 4.3 Guard adaptation (mock, step 3) — targeted, intent preserved

- **`verify_contract_isolation.mjs`** — **MANDATORY sub-directory scope:** `@trading-platform/sdk` (+ subpaths) is permitted **exactly** in `src/contract/ops-read/dto.sdk.ts` and **nowhere else** in `src/contract/**`. Every other file in the contract layer — including `research-read/dto.ts` — must remain free of any non-relative, non-stdlib import. The guard must **guarantee** this boundary (a SDK import appearing in any other contract file is a hard violation), not merely permit it globally. Rationale: `research-read/dto.ts` must stay machine-verifiably dependency-free / extractable; a blanket allow over `contract/**` would let it silently pick up the SDK and lose extractability.
- **`verify_no_forbidden_deps.mjs`:**
  - (a) add `@trading-platform/sdk` to `RUNTIME_ALLOWLIST`;
  - (b) narrow `DENYLIST` to keep blocking the private platform-runtime package(s) + `pg` / `ccxt` / exchange SDKs, but **not** `@trading-platform/sdk`;
  - (c) allowlist **exactly one** vendored-tgz `file:` specifier (the SDK tarball); all other `file:`/`link:`/`git+`/`git:`/`github:`/`workspace:` specifiers remain violations.
- **New mock verify step:** the vendored tgz matches the `package.json` specifier **and** its embedded `OPS_READ_CONTRACT_VERSION` equals the version the mock expects. Wired into `check:ci`.

## 5. Data flow

No runtime data-flow change. The mock continues to load snapshots through the existing fail-closed loader (secret-scan → manifest schema → exact-version compat → checksum → bundle secret-scan → bundle schema). The only change is the **origin of the TypeScript types** describing the bot-results primitives: they now come from the SDK instead of a local declaration. The wire shapes are identical (the hand copy was field-for-field), so serialized bundles and Surface A / Surface B responses are byte-unchanged — except a possible `opsReadContractVersion` string realignment if the SDK value ≠ `'ops.3'`.

## 6. Error handling / fail-closed posture

- Version drift between the vendored tgz and the mock's expectation → hard failure at the new verify step (build/CI), consistent with the existing "no migration policy yet" exact-match philosophy.
- Any contract-layer file other than `dto.sdk.ts` importing the SDK (or any external package) → hard `verify_contract_isolation` violation.
- Any forbidden dep (private platform runtime, `pg`, `ccxt`, exchange SDKs, or a non-allowlisted `file:`/`link:` specifier) reappearing → hard `verify_no_forbidden_deps` violation.
- SDK conformance fixture failing (SDK ops-read ⇄ `operations/dto.ts` drift) → hard gate failure on the platform side.

## 7. Testing

- **Platform:** new ops-read conformance fixture passes; `check:032/034` (incl. zero-bump + capability-absence) stay green; SDK packs cleanly (existing external-install gate).
- **Mock:** `pnpm check:ci` green = `typecheck + verify:contract-isolation + test + verify:no-forbidden-deps + verify:no-secrets` + new tgz-verify.
  - Existing snapshot loader / compat / validate / app tests stay green after any version-string realignment.
  - New test: barrel equivalence — types exported from `ops-read/dto.ts` are structurally identical to the previous local declarations (no accidental shape drift through the lift).
  - New test: tgz-verify (specifier match + embedded `OPS_READ_CONTRACT_VERSION` match).
  - New negative test: a contrived SDK import in a non-`dto.sdk.ts` contract file is rejected by `verify_contract_isolation`.

## 8. Sequencing (one shared plan, strictly sequential)

1. **SDK / platform:** lift the bot-results core + `OPS_READ_CONTRACT_VERSION` into `@trading-platform/sdk/ops-read`; add conformance fixture; pass `check:032/034`; repack tgz.
2. **tgz:** `npm pack` → vendor the tarball into the mock.
3. **Mock switch:** three-file split; `dto.sdk.ts` re-exports SDK; import version from SDK; realign fixtures if needed.
4. **Guards / CI:** narrow `verify_contract_isolation` (sub-directory scope), relax `verify_no_forbidden_deps` minimally, add tgz-verify; `pnpm check:ci` green.

## 9. Out of scope (strict — against scope creep)

- `trading-lab` (connects to the SDK contract in a later feature).
- Backtest research-gateway surface (live and backtest are separate semantics).
- Health / coverage / discover / page-envelope lift (separate future fork).
- `research-read/dto.ts` de-dup (no SDK counterpart; stays mock-owned).
- Any backtesting (`backtesting_moved_to_trading_backtester`).
- Any `pg` / `ccxt` / exchange / platform-runtime import in the mock; A3 is "the SDK owns platform contracts," **not** "a new standalone `@trading/contracts` monorepo."

## 10. Plan-time lookups — RESOLVED during planning

1. **Platform `OPS_READ_CONTRACT_VERSION` = `'ops.3'`** (`src/operations/version.ts`) — **identical** to the mock's value. **No fixture/manifest realignment needed.**
2. **`DENYLIST` narrowing:** the SDK package is `@trading-platform/sdk`; the private platform is the unscoped `trading-platform` repo/package. The guard keeps denying bare `trading-platform` and any `@trading-platform/*` **except** `@trading-platform/sdk` (rule expressed as: deny `@trading-platform` tokens unless immediately followed by `/sdk`). `pg`/`ccxt`/exchange SDKs stay denied unchanged.
3. **SDK package version = `0.3.0`** → tarball `trading-platform-sdk-0.3.0.tgz`. The `exports` map gains a `"./ops-read"` entry. **Mechanism is own-declared + conformance** (see §4.1); `gen_sdk_snapshot.mjs` is untouched.
4. **`RunSummary` confirmed distinct.** The ops `RunSummary` (interface `extends ClosedTradesAggregate`; fields `runId`/`excludesReconcile`/`asOf`) is consumed by the Surface A handler `src/operations/handlers/get-summary.ts::getSummary`. It is **not** the research `RunResultSummary` (different name, produced by `buildRunSummary` in the gateway worker), and `getRunSummary` / `ResearchRunResult` do not exist in `trading-platform` proper. The conformance fixture pairs `Mutual<Sdk.RunSummary, PlatOps.RunSummary>` against `dist/src/operations/dto.js` only.
