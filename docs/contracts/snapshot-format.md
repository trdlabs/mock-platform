# Snapshot Format Contract

This document describes the format that the operator-side exporter must produce for
`trading-mock-platform` to load. The mock validates every snapshot fail-closed against
these shapes at startup and refuses to serve if anything is missing or malformed.

---

## Directory layout

A snapshot lives in a directory under `MOCK_SNAPSHOT_DIR` (default `./data/snapshots`),
identified by `MOCK_SNAPSHOT_REF` (e.g. `fixtures/2026-06-16-synthetic`).

```
<MOCK_SNAPSHOT_DIR>/<ref>/
  manifest.json       — version envelope + file pointers
  checksums.json      — sha256 hex of each data file
  ops/
    bundle.json       — all sanitized data in one JSON blob
```

---

## `manifest.json`

The manifest is a JSON object with exactly these fields (no extra fields — validated with
`additionalProperties: false`):

```json
{
  "ref": "<same string as the directory name>",
  "createdAtMs": 1718503600000,
  "bundleRef": "ops/bundle.json",
  "checksumsRef": "checksums.json",
  "versions": {
    "snapshotSchemaVersion": "snapshot.1",
    "opsReadContractVersion": "ops.6",
    "researchReadContractVersion": "research.1",
    "analysisContractVersion": "ops.4",
    "exporterVersion": "<exporter-semver or label>",
    "sourcePlatformCommit": "<git SHA or 'synthetic'>",
    "redactionPolicyVersion": "<policy-label>"
  }
}
```

The values above are the ones the current mock accepts; `opsReadContractVersion`
tracks the pinned SDK (`@trdlabs/sdk/ops-read`) and has moved
`ops.3 → ops.6` since this contract was first written.

The mock performs **exact-match** version checks on startup: any other value —
even an adjacent one like `opsReadContractVersion: "ops.5"` — is rejected, since
no migration or range-match layer exists yet (`src/snapshot/compat.ts`).

Four of the seven fields are gated that way: `snapshotSchemaVersion`,
`opsReadContractVersion`, `analysisContractVersion`, `researchReadContractVersion`.
The remaining three — `exporterVersion`, `sourcePlatformCommit`,
`redactionPolicyVersion` — are provenance labels: they are schema-validated as
present strings but not matched against anything, so they carry no gate. Keep all
seven current anyway; the provenance three are what makes a snapshot traceable
back to its export.

---

## `checksums.json`

An object mapping relative paths (from the snapshot root) to their SHA-256 hex digest:

```json
{
  "ops/bundle.json": "<sha256-hex>"
}
```

The mock verifies the hash of every listed file before parsing. A mismatch aborts
startup.

---

## `ops/bundle.json` — `SnapshotBundle`

A single JSON object. Every fixed-shape sub-object uses `additionalProperties: false`
in the AJV schema — an extra field on a run record, trade, event, etc. causes startup
to fail closed.

### Top-level keys

All required except `historical`, which is absent in pre-008 snapshots.

| Key | Type | Description |
|-----|------|-------------|
| `runs` | `BotRunRecord[]` | All bot runs in the snapshot window |
| `tradesByRun` | `Record<runId, ClosedTrade[]>` | Closed trades keyed by run id |
| `eventsByRun` | `Record<runId, OperationalEvent[]>` | Operational events keyed by run id |
| `decisionsByRun` | `Record<runId, DecisionLogEntry[]>` | Decision-log entries keyed by run id |
| `tradeEvidenceByTrade` | `Record<tradeId, TradeEvidence>` | Per-trade forensic evidence (entry/exit prices + lifecycle), keyed by trade id |
| `runtimeHealth` | `RuntimeHealthCollection` | Runtime health per source at export time |
| `marketHealth` | `MarketServiceHealthSnapshot` | Market service health at export time |
| `executionHealth` | `ExecutionHealthSnapshot` | Execution subsystem health at export time |
| `coverage` | `SourceCoverageSnapshot` | Market data coverage per (source, kind) pair |
| `analysisByRun` | `Record<runId, AnalysisSnapshot>` | Tier-2 analysis per run (may be empty) |
| `researchByRun` | `Record<runId, ResearchRunResult>` | Research-read view per run (may be empty) |
| `replay` | `{ frames: ReplayFrame[] }` | WS replay sequence |
| `historical` | `HistoricalBundle` *(optional)* | Historical Read surface — absent in pre-008 snapshots |

All shapes are defined in `src/contract/` — see `src/contract/snapshot/bundle.ts` and
the referenced DTOs.

### `historical` — `HistoricalBundle`

| Key | Type | Description |
|-----|------|-------------|
| `barsBySymbolAndTimeframe` | `Record<symbol, Record<timeframe, OhlcvBar[]>>` | OHLCV bars per symbol and timeframe (`1m`/`5m`/`15m`/`1h`/`4h`/`1d`) |
| `fundingBySymbol` | `Record<symbol, FundingEntry[]>` | Funding-rate series |
| `openInterestBySymbol` | `Record<symbol, OpenInterestEntry[]>` | Open-interest series |
| `liquidationsBySymbol` | `Record<symbol, LiquidationEntry[]>` | Liquidation events |
| `rowsBySymbol` | `Record<symbol, CanonicalRowV2[]>` *(optional)* | Merged canonical minute rows — the `historical.2` source for `/historical/rows` |

`rowsBySymbol` is what `/historical/rows` serves. When it is absent, rows are
synthesized from `barsBySymbolAndTimeframe` — but **only** when that symbol's
finest timeframe is `1m`. A snapshot whose bars are coarser (1h/1d) cannot back
minute rows: `CanonicalRowV2.minute_ts` names a minute, and projecting hourly
bars into it produces data a consumer cannot tell apart from real minute rows.
Such a snapshot reports the `rows` resource as `unavailable` on
`/historical/discover` and answers `/historical/rows` with
`404 minute_rows_unavailable` (control-center audit P1-2). Its bars stay in the
snapshot and are described, with their own timeframe, by `/historical/coverage`.

### Capability-aware fields

Fields that cannot be safely or reliably sourced must be emitted as a
`CapabilityAbsent` object rather than omitted or fabricated:

```json
{ "available": false, "reason": "<why>" }
```

Examples: `strategyConfig`, `dcaCount`, `slTpBeEvents`, `features` in `AnalysisSnapshot`;
`sharpe` in `ResearchMetrics`. The `reason` string is free-form but should be one of:
`not_in_sanitized_export`, `not_safely_sourced`, `insufficient_sample`,
`market_features_out_of_scope_in_<phase>`.

### `profitFactor` omission rule

`AnalysisSnapshot.metrics.profitFactor` and `ResearchMetrics.profitFactor` are
optional. Omit the field entirely when absolute gross loss is zero (to avoid emitting
`"Infinity"`). Never emit a string containing `"Infinity"` or `"NaN"`.

---

## Fixture floor

A snapshot intended for use as the committed synthetic fixture must satisfy:

- At least 2 bot runs covering at least 2 different modes (e.g. `live` + `paper`).
- At least 1 winning closed trade (`isWin: true`) and at least 1 losing closed trade
  (`isWin: false`) in at least one run's `tradesByRun` entry.
- At least 1 `AnalysisSnapshot` entry in `analysisByRun` with capability-aware absent
  fields (`strategyConfig`, `dcaCount`, `slTpBeEvents`, `features` all `{available:false}`)
  to exercise the Tier-2 capability path.
- `coverage.entries` must include at least one `state: "present"` and at least one
  `state: "unsupported"` entry, to exercise state-diversity in conformance tests.
- No raw (unsanitized) snapshots are ever committed to git or baked into the image. Only
  the synthetic fixture lives under `data/snapshots/fixtures/`; real snapshots are
  mounted at runtime (`data/snapshots/real:ro`) and excluded by `.gitignore`.
