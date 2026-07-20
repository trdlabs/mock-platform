# trading-mock-platform

Standalone, read-only, snapshot-backed mock of the **read surfaces** of the private `trading-platform`.
Lets `trading-office` (and, in a later increment, `trading-lab`) run in demo/course/research environments
without the private live platform, exchanges, credentials, prod DB, or VPS.

## Surfaces
- **Surface A — Ops Read** (consumer: trading-office): HTTP GET (`ops.6`, **partial** parity — see
  [Ops Read parity](#surface-a--ops-read-parity)) + WS `/ops/events` replay, plus Tier-2
  `/ops/runs/:id/analysis` (`ops.4`, capability-aware), which the platform does not serve.
- **Surface B — Research Read** (consumer: trading-lab): contract + snapshot→DTO adapter + read-only
  capability descriptor. Transport (MCP/HTTP) is a future increment — this feature ships the seam only.
- **Surface C — Historical Read** (`/historical/rows`): HTTP GET serving full `CanonicalRowV2` pages
  (`historical.2`), proven byte-identical to the real platform via a shared conformance harness.

It does NOT execute or simulate trading or backtesting, hold credentials, reach an exchange/prod DB, or
ingest live data. Backtest/hypothesis execution belongs to the future separate `trading-backtester`.

## Run
```bash
cp .env.example .env
pnpm install && pnpm build
MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic pnpm start
curl -s localhost:8839/ops/discover
```

## Surface A — Ops Read parity

The mock advertises `ops.6` — the same contract version the platform declares
(`src/operations/version.ts`) — but it serves a **subset** of the platform's `/ops` routes, plus one
route the platform does not have. "`ops.N` parity" means the shapes match on the routes both serve,
not that the route sets are equal.

**Served by both** (11): `/ops/discover`, `/ops/runs`, `/ops/runs/:runId/summary`, `/ops/trades`,
`/ops/trade-evidence`, `/ops/events` (GET list + WS upgrade), `/ops/decisions`,
`/ops/health/{runtime,market,execution}`, `/ops/coverage`.

**On the platform, not in the mock** (7):

| Route | Note |
| --- | --- |
| `/ops/positions` | live position state — nothing in a sanitized snapshot to back it |
| `/ops/runs/:runId/state` | live run state |
| `/ops/runs/:runId/positions` | live per-run positions |
| `/ops/runs/:runId/trades` | the mock covers the same data as `/ops/trades?runId=` |
| `/ops/log-refs` | log pointers — deliberately out of the sanitized export |
| `/ops/candidates` | paper-candidate intake |
| `/ops/candidates/:candidateId` | paper-candidate intake |

A consumer calling any of these against the mock gets Hono's default `404 Not Found` (plain text),
not an `OpsError` — the route simply is not registered.

**In the mock, not on the platform** (1): `/ops/runs/:runId/analysis` — the Tier-2, capability-aware
`AnalysisSnapshot` view (`ops.4`). The platform's ops-read surface has no analysis route at all, so
this is **mock-only**: it is served from `analysisByRun` in the snapshot and has no real counterpart
to be byte-compared against. Treat it as a mock affordance, not as platform behaviour to rely on.

## Point trading-office at the mock (no code change)
```
OFFICE_CONNECTOR_MODE=trading-lab
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://localhost:8839
TRADING_PLATFORM_READ_TOKEN=<non-empty>
```

## Consumers (framing)
- trading-office = direct Ops Read HTTP consumer.
- trading-lab = platform bot-results/research-read consumer via the current SDK/MCP path (mock integration deferred here).
- trading-backtester = future separate executor for hypothesis/backtest lifecycle.

## Safety
Read-only; sha256-hashed token allowlist; loopback by default; fail-closed if bound non-loopback without a token.
Snapshots are verified on load (manifest + checksums + version-compat + secret-scan). The exporter/sanitizer
runs operator-side near the private platform and is out of scope here — see `docs/contracts/`.

## Shared SDK (`@trdlabs/sdk`)

The shared contract types come from the **published npm package** `@trdlabs/sdk`, pinned to an **exact
version** (no range) in `package.json`. Nothing is vendored and nothing is fetched from a tarball URL.

Two contract files — and only these two — may import it, enforced by `verify:contract-isolation`:

| Seam | Subpath | What it re-exports |
| --- | --- | --- |
| `src/contract/ops-read/dto.sdk.ts` | `@trdlabs/sdk/ops-read` | live bot-results primitives + `OPS_READ_CONTRACT_VERSION` |
| `src/contract/historical-read/dto.sdk.ts` | `@trdlabs/sdk/historical` | `CanonicalRowV2` |

Everything else in `src/contract/**` — notably `research-read/dto.ts` — stays dependency-free and
extractable. The conformance harness comes from the same package (`@trdlabs/sdk/conformance`); see
Surface C below.

**To move to a new SDK version:** publish it from the `trdlabs/sdk` repo, then bump *both* the
`package.json` dependency and `EXPECTED_SDK_VERSION` in `scripts/verify_sdk_pin.ts` — the gate fails if
the two disagree, so they cannot drift. Run `pnpm install` and `pnpm check:ci`.

> **History.** The SDK used to be `@trading-platform/sdk`, delivered first as a vendored
> `vendor/*.tgz` and later as a GitHub release-asset URL, because no npm release existed. That is over
> (control-center initiative `mock-contract-parity`, item 5). The legacy package name is now a
> *forbidden* import everywhere in the contract layer, and non-registry specifiers have no carve-out
> left — both are asserted by tests, so a partial revert cannot pass CI.

## CI guard

Every PR to `main` (and every push to `main`) runs `.github/workflows/ci.yml` — two parallel jobs:

- **checks:** `pnpm check` (typecheck + contract-isolation + tests) → `pnpm verify:no-forbidden-deps` → `pnpm verify:no-secrets` → `pnpm verify:sdk-pin` → `pnpm verify:golden-sync`
- **docker:** `docker build` (public deps only, no registry/private access)

What it enforces, automatically:
- types + tests (`pnpm check`)
- `src/contract/**` import isolation
- no secrets / forbidden patterns in committed data files (`.json`/`.parquet`/`.env`/… anywhere; `src`/`test`/`docs` and `.gitkeep` excluded)
- no private/forbidden dependencies — runtime `dependencies` allowlist + a denylist (`trading-platform`, `pg`, `ccxt`, exchange SDKs, and **every** `@trading-platform/*` with no exception) across the lockfile + a ban on `file:`/`link:`/`git+`/`https:`/`workspace:` specifiers, also with no exception
- the SDK is an exact npm pin whose installed `SDK_VERSION` matches, carrying the expected `ops.6` and exporting the conformance harness (`verify:sdk-pin`)
- the vendored platform golden matches its recorded sha256, and byte-matches the platform source when that repo is reachable (`verify:golden-sync`)
- the image builds with public deps only

Run all of it locally with `pnpm check:ci`.

**Manual operator step (one-time):** enable branch protection on `main` requiring the **`checks`** and **`docker`** status checks before merge (GitHub → Settings → Branches → Branch protection rules). CI cannot set this itself.

## Surface C — Historical Read (`/historical/rows`, full canonical rows)

`GET /historical/rows?symbols=<csv>&fromMs=&toMs=&limit=&cursor=` → `PageEnvelope<CanonicalRowV2>`.
Each item is a **full canonical row** (contract `historical.2`): OHLCV + turnover, open interest, funding,
liquidations, and the taker triplet. `symbols` is a comma-separated list; `fromMs`/`toMs` bound the window
as a **half-open range `[fromMs, toMs)`** — the bar at `minute_ts == toMs` is not returned and `[t, t)` is
empty (`toMs` optional → open-ended); `limit` + opaque `cursor` page the result (unknown symbols yield an
empty page, not an error). A multi-symbol request is served as one **globally ordered** stream —
`(minute_ts ASC, symbol ASC)` across all pages, not a per-symbol concatenation in request order. Both match
platform semantics (control-center audit P0-1 / P1-1). This is additive: it changes only how `rows`
answers, leaving `/historical/discover` and `/historical/coverage` as they were.

**Minute grain is required — no silent hourly "minute" rows.** `CanonicalRowV2.minute_ts` names a
minute, so `/historical/rows` is served only from a minute-grain source: native `rowsBySymbol`, or
bars whose finest timeframe is `1m`. A bars-only snapshot at 1h/1d grain (e.g.
`fixtures/2026-06-16-synthetic`, `fixtures/2026-06-12-real-top5`) used to have its hourly bars
projected into `minute_ts` — rows stepping by an hour while claiming to be minute data, which a
consumer could not detect and which silently corrupts any backtest over them (control-center audit
P1-2). Such a snapshot now reports the `rows` resource as `unavailable` in `/historical/discover`,
omits `1m` from `timeframes`, and answers `/historical/rows` with `404 minute_rows_unavailable`
rather than an empty page — an empty page is indistinguishable from "your window matched nothing".
The bars themselves are untouched: they stay in the snapshot and are described, with their own
timeframe, by `/historical/coverage` and `/historical/discover`. (There is no `/historical/bars`
endpoint — the historical surface is `discover`, `rows`, `coverage`.)

The guard is scoped to the **requested symbols**, not to the snapshot as a whole: a mixed
snapshot can carry native minute rows for one symbol and only 1h bars for another, so a request
naming only coarse-only symbols fails even though the resource is available. A request naming at
least one minute-capable symbol is served, and coarse-only symbols in it contribute nothing.
Unknown symbols keep yielding a graceful empty page whenever the resource is available.

The ecosystem default fixture (`fixtures/2026-06-22-to-2026-06-28-vps`) carries native 1m data and
is unaffected. Note that the *code*-default `MOCK_SNAPSHOT_REF` (`fixtures/2026-06-16-synthetic`) is
bars-only, so starting the mock without an explicit ref now yields `minute_rows_unavailable` on
`/historical/rows` — that is the correct answer for that snapshot; set `MOCK_SNAPSHOT_REF` to a
fixture with native 1m when you need rows.

**Golden fixture.** `data/snapshots/fixtures/historical-golden` is a deterministic snapshot covering all
canonical kinds, generated from the platform `MANIFEST` by `scripts/make-golden-fixture.ts`. It carries two
symbols: the 30 verbatim golden `BTCUSDT` rows (the byte-identity source of truth) plus a derived
`ETHUSDT` companion on the same minute grid, so multi-symbol ordering is falsifiable rather than skipped.

**Error shape diverges from the platform — deliberately.** Byte-identity is proven for *successful*
responses; the error paths are not identical, and the mock is the stricter of the two.

| Case | Platform `/historical/*` | Mock `/historical/*` |
| --- | --- | --- |
| Error body | `{ "error": "<text>" }` (flat string) | `{ category, code, message }` (`OpsError`, same shape as `/ops/*`) |
| Invalid cursor | `400 {error:"invalid cursor"}` | `400 {category:"validation_error", code:"invalid_cursor", …}` |
| Unknown symbol | `200` empty page | `200` empty page — **same** |
| Non-numeric `fromMs`/`toMs`/`limit` | no validation; `Number()` → `NaN`, `200` empty page | same passthrough, `200` empty page |
| Historical absent from the snapshot | n/a — the platform always has a store; `/historical/coverage` signals `availability` in the body, `200` | `404 historical_unavailable` |
| No minute-grain source | n/a | `404 minute_rows_unavailable` |
| Any 404 | **never returned by a registered `/historical/*` handler** — no `404` literal and no `notFound` handler in the app | returned for the two `not_found` cases above |

On both sides an *unknown path* under `/historical/` still gets Hono's built-in plain-text
`404 Not Found` — that is the router, not the handlers, and it is the one 404 behaviour the two share.

The divergence is documented rather than removed. Collapsing the mock onto `{error:"…"}` would drop
the machine-readable `code` that `minute_rows_unavailable` depends on (the P1-2 guard's whole point is
that a consumer can *tell* why it got nothing), and would split the mock's own error convention in two,
since `/ops/*` already emits `OpsError` on both sides. The mock's extra 404s describe snapshot states
the platform cannot be in — it always has a historical store — so there is no platform behaviour they
contradict. What a consumer must not assume is that a *shape* seen against the mock's error path will
match the platform's; only the success path is contract-guaranteed.

**Conformance (mock == real).** The shared conformance harness is imported straight from the pinned
npm package — `@trdlabs/sdk/conformance` — so the mock and every other consumer run the *same*
published artifact. There is no vendored copy and no sync gate for it; `verify:sdk-pin` asserts the
subpath is exported by the pinned version. Running it against this mock and against the real platform
over the golden fixture proves **byte-identity** (30 rows) — the mock's `/historical/rows` response is
indistinguishable from the real one. The harness reports checks a dataset cannot exercise as *skips*;
the mock's conformance test fails on any non-empty skip list, so coverage cannot shrink silently.

The golden fixture itself is still vendored (`test/conformance/_vendored/platform-historical-golden.json`),
because the platform — not the SDK — owns it. `verify:golden-sync` keeps it honest: a hard sha256 check
always, plus a byte-compare against the platform repo whenever that checkout is reachable.

## Surface B — Research Read (trading-lab, stdio MCP gateway)

`trading-lab` reads the mock through its current MCP-over-stdio path — point it at the gateway with env only, no lab code change:

```
TRADING_PLATFORM_INTEGRATION=mcp
TRADING_PLATFORM_GATEWAY_COMMAND=docker
TRADING_PLATFORM_GATEWAY_ARGS=run -i --rm -e MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic trading-mock-platform:dev node dist/src/bin/start-research-mcp.js
# optional access control (sha256-hex allowlist; empty = spawn-trusted):
#   pass MOCK_RESEARCH_TOKENS (expected) into the container and MOCK_RESEARCH_TOKEN (raw) via the spawn env
```

The gateway speaks the MCP-031 contract (`017.2`): `discover_research_contract`, `list_datasets` (empty — historical canonical rows are served over HTTP via the `/historical/rows` surface below), `get_run_status`, `get_run_result` are served read-only from the snapshot; `validate_module` / `submit_run` / `cancel_run` return `{ok:false, error}` with reason `backtesting_moved_to_trading_backtester` — **no backtesting is implemented or faked here**. stdout carries JSON-RPC only; all logs/audit go to stderr. Backtest/hypothesis execution belongs to the future `trading-backtester`.
