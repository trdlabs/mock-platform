# 2026-06-20 — Real-data demo fixture (top-5 symbols) — design

## Problem

The committed demo fixture `fixtures/2026-06-16-synthetic` is functionally complete
(both ops + historical surfaces) but thin: 2 trades, 1 synthetic symbol. A third party
(e.g. a teacher) who runs `docker-compose.demo.yml` gets a working but visually empty
demo. We want a **richer fixture built from real trades on real symbols**, committed to
git, so the demo is convincing without anyone needing the private VPS or an SSH key.

Repository visibility/sensitivity: the repo is **public**, and the owner considers the
concrete trades **non-sensitive** — no manual redaction step is required. `scanForSecrets`
(load-time) and `pnpm verify:no-secrets` (CI) remain the automatic safety net.

## Source data (already on disk, gitignored)

`data/snapshots/2026-06-12-vps/ops/bundle.json` (101 MB on disk) — produced earlier by the
`fetch-snapshot` tool. It contains:

- 2 real bot runs, **110 real trades** across 31 real low-cap futures symbols
- per-symbol historical: 1h/1d bars, plus **per-minute** funding / open interest /
  liquidations (these three series are ~53 MB of the bundle, ~8–9 k rows/symbol/week)
- decisions (0.39 MB), research (0.21 MB), health, coverage, replay

No new `fetch:snapshot` run, no VPS, no SSH is involved — the tool below derives the
committed fixture from this local snapshot.

## Decision (variant B — full minute resolution)

Build `fixtures/2026-06-12-real-top5` containing the **top-5 symbols by trade count**, at
**native per-minute resolution** for funding/OI/liquidations.

Top-5 (by trade count in the source): **ESPORTSUSDT (25), HUSDT (21), SIRENUSDT (12),
BEATUSDT (10), COAIUSDT (5)** — 73 trades total, window 2026-06-12 → 2026-06-18 (6.6 days).

Expected committed size: **~8–9 MB** (compact, no-whitespace JSON). The owner accepted this
weight in a public repo (full fidelity preferred over a lighter downsampled variant).

## Components

### 1. Authoring tool — `scripts/make-fixture.ts`

A reproducible, reviewable subsetting tool (not a hand-edited JSON blob). Pure Node +
contract types — **no `pg`/`hyparquet`** — so it typechecks under the repo's `tsconfig`
(`include: ["src","test","scripts"]`) and participates in `pnpm check` with no forbidden deps.

Invocation:

```sh
tsx scripts/make-fixture.ts \
  --source data/snapshots/2026-06-12-vps \
  --out    data/snapshots/fixtures/2026-06-12-real-top5 \
  --top    5
```

Responsibilities:
- read + parse the source `bundle.json` (uses `--max-old-space-size` via the run command)
- compute the top-N symbols by trade count (deterministic; tie-break by symbol name asc)
- filter every section to those symbols (see rules below), preserving all schema keys
- write `ops/bundle.json` (compact), regenerate `manifest.json` and `checksums.json`
- self-validate the output through the same `loadSnapshot` path before exit (fail loud)

Like `fetch-snapshot`, this is an **authoring-side** tool: it reads a gitignored local
snapshot that consumers do not have. Consumers only ever use the committed output.

### 2. Filtering rules (keep keys, filter values)

The output must still pass `assertValidBundle` (AJV, exact keys, `additionalProperties:false`),
so every required top-level key is retained — emptied, not dropped, where a section has no
surviving rows.

| Section | Rule |
|---|---|
| `runs` | keep runs that retain ≥1 trade after filtering (both qualify) |
| `tradesByRun` | keep trades whose `symbol` ∈ top-5 (→ 73 trades) |
| `eventsByRun` | keep events for retained runs; filter by `symbol` when present (source has 0) |
| `decisionsByRun` | keep for retained runs; filter by `symbol` when the record carries one |
| `analysisByRun` / `researchByRun` | keep for retained runs |
| `historical.barsBySymbolAndTimeframe` | keep top-5 symbols, all timeframes, full |
| `historical.fundingBySymbol` / `openInterestBySymbol` / `liquidationsBySymbol` | keep top-5 symbols, **full per-minute resolution** |
| `marketHealth` | filter by symbol → top-5 |
| `runtimeHealth` / `executionHealth` | keep as-is (global) |
| `coverage` | recompute from the filtered data (symbols + actual window/timestamps) |
| `replay` | keep, scoped to retained runs |

### 3. Manifest + checksums

`manifest.json`: `ref: "2026-06-12-real-top5"`, `bundleRef: "ops/bundle.json"`,
`checksumsRef: "checksums.json"`, `createdAtMs` stamped at generation time, `versions`
copied verbatim from the source manifest (`snapshotSchemaVersion: snapshot.1`,
`opsReadContractVersion: ops.3`, `researchReadContractVersion: research.1`,
`analysisContractVersion: ops.4`, `redactionPolicyVersion` copied), `exporterVersion` set to
`fixture-trim.1`, `sourcePlatformCommit` copied. `checksums.json`: `{ "ops/bundle.json":
"<sha256-hex>" }` matching the loader's `verifyChecksum`.

### 4. Demo default wiring

- `trading-lab/docker-compose.demo.yml`: change the `MOCK_SNAPSHOT_REF` default from
  `fixtures/2026-06-16-synthetic` to `fixtures/2026-06-12-real-top5`.
- **Do not** change the code default in `src/access/config.ts` or `start-research-mcp.ts`
  (`fixtures/2026-06-16-synthetic`) — tests and the research-MCP startup rely on it. The
  synthetic fixture stays; the real one is added alongside.
- Update demo docs (`trading-lab/README.md` demo section, `docs/docker-demo.md`) to name the
  real fixture and its 5 symbols.

### 5. Integration risk to resolve in the plan

The lab → backtester demo cycle must request a backtest on a symbol that exists in the
fixture (one of the 5), otherwise the backtester answers `unavailable`. The plan must check
the demo's default symbol (lab hypothesis/strategy default, `e2e.mjs`) and align it to a
top-5 symbol (e.g. `ESPORTSUSDT`). Office (ops read) needs no symbol alignment.

## Testing

- New test that loads `fixtures/2026-06-12-real-top5` through `loadSnapshot` and asserts:
  validates against schema + manifest, checksum verifies, exactly 5 symbols present in
  historical, trade count == 73, both runs present. (Mirror the existing checksums test.)
- `pnpm verify:no-secrets` must pass with the new ~8–9 MB data file included.
- `pnpm check:ci` stays green (typecheck picks up `scripts/make-fixture.ts`).

## Out of scope

- Any change to the `fetch-snapshot` tool or a new VPS fetch.
- Manual sanitization/redaction beyond the source's existing redaction (owner deemed the
  data non-sensitive; `scanForSecrets` is the safety net).
- Removing or altering the synthetic fixture.
- Downsampling the heavy historical series (variant A/compromise rejected — full fidelity).

## Success criteria

Running the demo with the new default brings up a stack where office shows 73 real trades
across 5 real symbols, lab can request and complete a backtest on one of those symbols
using committed historical data, and the whole fixture lives in git at ~8–9 MB with all
repo gates green — no VPS, no SSH, no private platform.
