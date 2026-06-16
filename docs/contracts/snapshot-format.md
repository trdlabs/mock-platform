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
    "opsReadContractVersion": "ops.3",
    "researchReadContractVersion": "research.1",
    "analysisContractVersion": "ops.4",
    "exporterVersion": "<exporter-semver or label>",
    "sourcePlatformCommit": "<git SHA or 'synthetic'>",
    "redactionPolicyVersion": "<policy-label>"
  }
}
```

The mock performs **exact-match** version checks on startup. A snapshot with
`opsReadContractVersion: "ops.2"` or `"ops.4"` is rejected — no migration or
range-match is applied in the MVP. Update all seven version fields when the
contracts change and a matching mock release is deployed.

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

### Top-level keys (all required)

| Key | Type | Description |
|-----|------|-------------|
| `runs` | `BotRunRecord[]` | All bot runs in the snapshot window |
| `tradesByRun` | `Record<runId, ClosedTrade[]>` | Closed trades keyed by run id |
| `eventsByRun` | `Record<runId, OperationalEvent[]>` | Operational events keyed by run id |
| `decisionsByRun` | `Record<runId, DecisionLogEntry[]>` | Decision-log entries keyed by run id |
| `runtimeHealth` | `RuntimeHealthCollection` | Runtime health per source at export time |
| `marketHealth` | `MarketServiceHealthSnapshot` | Market service health at export time |
| `executionHealth` | `ExecutionHealthSnapshot` | Execution subsystem health at export time |
| `coverage` | `SourceCoverageSnapshot` | Market data coverage per (source, kind) pair |
| `analysisByRun` | `Record<runId, AnalysisSnapshot>` | Tier-2 analysis per run (may be empty) |
| `researchByRun` | `Record<runId, ResearchRunResult>` | Research-read view per run (may be empty) |
| `replay` | `{ frames: ReplayFrame[] }` | WS replay sequence |

All shapes are defined in `src/contract/` — see `src/contract/snapshot/bundle.ts` and
the referenced DTOs.

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
