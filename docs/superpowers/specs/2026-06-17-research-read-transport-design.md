# Feature 003 — Live Surface B Transport (Research Read for trading-lab) — Design

**Status:** approved (design accepted 2026-06-17). Next: implementation plan → review before implementation.

## Problem

Feature 001 shipped a Research Read *seam* (`src/contract/research-read` + `src/research-read/adapter`) but no live transport, so `trading-lab` cannot actually read the mock. Lab consumes the platform's research surface over **MCP-over-stdio** via `@modelcontextprotocol/sdk` (it spawns a gateway subprocess). Feature 003 raises a live transport over the seam's data so lab reads the mock through its **current SDK/MCP path with zero lab-side code changes**.

## Investigation findings that shape this (evidence)

- Lab's transport is **hardwired to `StdioClientTransport`** (`trading-lab/src/adapters/platform/mcp-research-transport.ts:71-91`) — no HTTP/SSE, no URL config. The only zero-rework path is a **stdio MCP gateway** the mock ships, spawned by changing only `TRADING_PLATFORM_GATEWAY_COMMAND`/`_ARGS`.
- Lab's SDK speaks the platform's **MCP-031 gateway contract** — 8 tools `discover_research_contract`, `list_datasets`, `validate_module`, `submit_run`, `cancel_run`, `get_run_status`, `get_run_result`, `read_artifact` (lab calls 6: discover, listDatasets, validateModule, submitRun, getRunStatus, getRunResult). This is a **different schema** from the mock's existing `research.1` seam (`listBotResults`/`getRunSummary`/`ResearchRunResult`). The seam's *data adapter* is reusable; the **wire contract over MCP must be MCP-031**.
- `@modelcontextprotocol/sdk` is lab's normal npm dep at `^1.29.0` (not vendored). `@trading-platform/sdk` is vendored in lab as a tarball; its `dist/agent/*.d.ts` defines the MCP-031 tool I/O types.

## Decisions (locked)

1. **Contract = MCP-031 projection.** The gateway exposes lab's exact MCP-031 tools and projects snapshot data into the SDK's wire shapes. The `research.1` seam becomes the internal data source.
2. **Add `@modelcontextprotocol/sdk`** (`^1.29`, matching lab's major; public, not denylisted) to `dependencies` **and** to the feature-002 `verify_no_forbidden_deps` allowlist. 002 stays green.
3. **Docker spawn:** lab spawns `docker run -i` against the mock image — `GATEWAY_COMMAND=docker`, `GATEWAY_ARGS="run -i --rm <mock-image> node dist/bin/start-research-mcp.js"`. Standalone, public-deps-only, snapshot via mounted volume, no private access.
4. **Access model over stdio:** read-only (mutating tools always refused); reuse the redacted `audit` module; optional `MOCK_RESEARCH_TOKEN` (empty = spawn-trusted, like Surface A's empty allowlist = loopback-trusted; non-empty = required, passed by lab via `GATEWAY_CONFIG`/env).

## Refinements (locked into this spec)

- **Fidelity:** mirror only the MCP-031 fields lab's adapter actually reads. `comparison` / `coverage` / `evidence` / `artifactRefs` and similar → **capability-aware omit**, never fabricated. **Acceptance condition:** verify against lab's `.d.ts` + adapter code that the adapter tolerates omitted optional fields without throwing; if it would throw on an absent field, emit an explicit **capability marker** (empty value / `null` carrying "unavailable" semantics) instead of the absent field — never an invented value.
- **`list_datasets`:** returns a **valid-empty result with a reason** ("no historical datasets — future `/historical` scope"); do NOT synthesize dataset descriptors from run symbols/timeframe. Empty must read as intentional, not an error.
- **SDK version pin & protocol drift (top risk):** pin `@modelcontextprotocol/sdk` to lab's major (`^1.29`); at the plan stage, verify the pinned version against lab's declared `@modelcontextprotocol/sdk` version (`trading-lab/package.json`) so client/server protocol versions agree.
- **Contract mirroring is read-only + import-clean:** extract the MCP-031 tool I/O types from lab's vendored `@trading-platform/sdk` `dist/agent/*.d.ts` (read-only, via gortex) and hand-mirror them into `src/contract/research-read/mcp/`. NEVER import `@trading-platform/sdk` or `@modelcontextprotocol/sdk` from the contract layer — the contract-isolation guard covers the new module (pure types only; no runtime deps introduced by mirroring).
- **stdio cleanliness (load-bearing):** on the gateway process, **stdout carries JSON-RPC only**; ALL audit, logs, and diagnostics go to **stderr**. Anything written to stdout outside the MCP framing corrupts the protocol. The reused `audit` module must write to stderr in this process.

## Architecture

A new stdio MCP gateway process. **Surface A (Ops Read HTTP/WS) is untouched.**

```
src/contract/research-read/mcp/          # NEW — import-clean MCP-031 tool I/O DTOs (hand-mirrored)
  dto.ts version.ts
src/research-read/mcp/
  projections.ts                         # NEW — pure SnapshotBundle → MCP-031 projections
  server.ts                              # NEW — builds MCP Server, registers the 8 tools
  errors.ts                              # NEW — {ok:false,error} unavailable/backtest responses
src/access/research-access.ts            # NEW — optional env-token check; audit-to-stderr helper
src/bin/start-research-mcp.ts            # NEW — stdio entrypoint (StdioServerTransport)
package.json                             # MODIFY — add @modelcontextprotocol/sdk dep + start script
scripts/verify_no_forbidden_deps.mjs     # MODIFY — add @modelcontextprotocol/sdk to the allowlist
Dockerfile / docker-compose.mock.yml     # MODIFY — ship/run the gateway; document lab GATEWAY_* env
README.md                                # MODIFY — Surface B (research-read) lab wiring
```

### Components

- **`src/contract/research-read/mcp/dto.ts`** — the MCP-031 tool I/O DTOs lab's SDK decodes: the `discover` descriptor (`contractVersion`, `supportedContractVersions`, `marketDataKinds`, `runModes`, `metricCatalog`, `robustnessCatalog`), `ListDatasetsResult`, `RunStatusView`/`RunStatusResult`, `RunResultSummary`/`RunResultResult`, and the `{ok:false, error}` union for mutating tools. Only the fields lab reads (+ explicit capability markers where needed). Pure types, no imports outside `src/contract`.
- **`src/research-read/mcp/projections.ts`** — pure `SnapshotBundle → MCP-031` functions: `discoverDescriptor()`, `listDatasets()` (valid-empty-with-reason), `runStatus(runId)`, `runResult(runId)` (metrics from `researchByRun`; `comparison`/`coverage`/`artifactRefs`/`evidence` omitted or capability-marked). Reuses `src/research-read/adapter` + `snapshot/readers/research`.
- **`src/research-read/mcp/server.ts`** — builds an MCP `Server` (from `@modelcontextprotocol/sdk`), registers the 8 `GATEWAY_TOOL_NAMES`; read tools → projections; `validate_module`/`submit_run`/`cancel_run` → `{ok:false, error:{…, message:'backtesting_moved_to_trading_backtester'}}`; `read_artifact` minimal/unavailable. Tool handlers never throw across the MCP boundary (errors become the SDK error arm).
- **`src/access/research-access.ts`** — optional `MOCK_RESEARCH_TOKEN` gate (empty = spawn-trusted; non-empty = required); a redacted audit emit that writes to **stderr** (never logs the token).
- **`src/bin/start-research-mcp.ts`** — stdio entrypoint: load config → `openSnapshot` (reuse registry/loader) → connect `StdioServerTransport`. Eager snapshot load at startup, same as Surface A.

### Data flow

lab `StdioClientTransport` ⇄ gateway `StdioServerTransport` → tool call → (token check + audit to stderr) → snapshot projection → SDK-shaped response on stdout (JSON-RPC framing only).

### Error handling

Missing run → the SDK's error arm (`{ok:false, error}`), never a throw. Mutating tools always the `backtesting_moved_to_trading_backtester` error. Unsafe/absent fields omitted or capability-marked, never invented.

## Testing & CI

- Unit-test the projections (snapshot → MCP-031 shapes; capability-aware omit/markers) and each tool handler (read → projected data; mutating → the unavailable error; missing run → error arm).
- One **integration test**: connect an in-process MCP `Client` (`@modelcontextprotocol/sdk`) over stdio to the server and exercise the read tools end-to-end (discover, list_datasets empty, get_run_status, get_run_result) + assert a mutating tool returns the unavailable error.
- **Feature-002 CI stays green:** new files come under `pnpm check` + `verify:no-forbidden-deps` (allowlist extended for `@modelcontextprotocol/sdk`) + `verify:no-secrets`; `docker build` stays public-deps-only.

## Acceptance criteria

1. `docker run -i --rm <mock-image> node dist/bin/start-research-mcp.js` runs an MCP stdio server; an MCP client completes `discover_research_contract`, `list_datasets`, `get_run_status`, `get_run_result` against the synthetic fixture and decodes them with lab's expected shapes.
2. `validate_module` / `submit_run` / `cancel_run` return the SDK `{ok:false, error}` with reason `backtesting_moved_to_trading_backtester` — no backtest is executed, simulated, or faked; no job lifecycle exists.
3. `list_datasets` returns a valid-empty result carrying a "no historical datasets" reason (not an error).
4. Omitted optional fields (`comparison`/`coverage`/`evidence`/`artifactRefs`): verified against lab's `.d.ts` + adapter that omission does not throw; where it would, an explicit capability marker is returned instead. No fabricated values anywhere.
5. The pinned `@modelcontextprotocol/sdk` major matches lab's (`^1.29`), verified against `trading-lab/package.json`.
6. `src/contract/research-read/mcp/**` is import-clean (no `@trading-platform/sdk`, no `@modelcontextprotocol/sdk`, no runtime imports) — `pnpm verify:contract-isolation` green.
7. stdout emits JSON-RPC only; all audit/logs/diagnostics go to stderr (verified by the integration test parsing clean JSON-RPC from stdout).
8. `pnpm check:ci` green (types + tests + contract-isolation + no-forbidden-deps + no-secrets); `docker build` public-deps-only. Surface A (Ops Read HTTP/WS) unchanged.

## Out of scope / boundaries (strict)

No backtest submit / hypothesis execution / fake results / job lifecycle / strategy simulation — mutating tools are `unavailable` with the reason. Mutation forbidden (read-only). Surface A contract/handlers untouched beyond necessity. No private/forbidden dependencies (002 enforces). No historical dataset API (`list_datasets` is empty-with-reason; real datasets are the future `/historical` scope). Gateway stays standalone in Docker, no private access. No changes to `trading-lab`.
