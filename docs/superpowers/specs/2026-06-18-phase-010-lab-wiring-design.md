# Phase 010 — Wire `trading-lab` to the Mock-Backed Backtester

**Date:** 2026-06-18  
**Roadmap phase:** 010  
**Author:** AI agent (superpowers/brainstorming)  
**Status:** Approved by user

---

## Goal

Make the full research loop work in demo/research mode without private platform dependencies.

The complete stack runs locally via a single `docker compose` command:
- `trading-mock-platform` — Ops Read (HTTP/WS) + Historical data surfaces
- `trading-backtester` — backtester service backed by mock historical data (Phase 009)
- `trading-lab` — AI research agent consuming both surfaces
- `trading-office` — web dashboard for trading-lab (already in base compose)

---

## Architecture

```
Browser
  └── office-web (Nginx :80)
        └── office-server (:8787)
              └── ingress (:3000) + worker
                    ├── HttpBacktesterAdapter → trading-backtester (:8080)
                    │     └── MockPlatformDataPort → trading-mock-platform (:8839)
                    └── HttpOpsReadAdapter (bot-results) → trading-mock-platform (:8839)
```

All four services share a single `trading` Docker network. `trading-mock-platform` is the only service visible on `127.0.0.1` host ports (8839) for local development inspection.

---

## Components

### 1 — Dockerfile for `trading-backtester`

**Location:** `trading-backtester/Dockerfile`

Multi-stage build (consistent with `trading-mock-platform/Dockerfile`):

- **Stage `build`**: `node:22-slim`, corepack, full `pnpm install`, `pnpm -r build` (tsc → dist/)
- **Stage `runtime`**: `node:22-slim`, corepack, `pnpm install --prod`, copy `dist/`, `packages/*/dist/`
- Entry point: `node apps/backtester/dist/index.js`
- Default bind: `BACKTESTER_HOST=0.0.0.0`, `BACKTESTER_PORT=8080`
- `EXPOSE 8080`

Key constraint: pnpm workspace means workspace packages (`@trading/research-contracts`, `@trading-backtester/client`) must be copied and built before the app package. The multi-stage approach handles this via `pnpm -r build`.

### 2 — `docker-compose.research-demo.yml` in `trading-lab`

**Location:** `trading-lab/docker-compose.research-demo.yml`

Overlay on top of `docker-compose.yml`. Launched with:
```bash
docker compose -f docker-compose.yml -f docker-compose.research-demo.yml \
  --env-file .env.research-demo up --build
```

**New services added by the overlay:**

```yaml
trading-mock-platform:
  build: { context: ../trading-mock-platform }
  image: trading-mock-platform:research-demo
  environment:
    MOCK_OPS_BIND: 0.0.0.0
    MOCK_OPS_PORT: "8839"
    MOCK_OPS_TOKENS: "${MOCK_OPS_TOKENS:?required}"
    MOCK_SNAPSHOT_REF: fixtures/2026-06-16-synthetic
    MOCK_REPLAY_MODE: loop
  ports: ["127.0.0.1:8839:8839"]
  networks: [trading]

trading-backtester:
  build: { context: ../trading-backtester }
  image: trading-backtester:research-demo
  environment:
    BACKTESTER_HOST: 0.0.0.0
    BACKTESTER_PORT: "8080"
    BACKTESTER_DATA_SOURCE: mock
    BACKTESTER_MOCK_PLATFORM_URL: http://trading-mock-platform:8839
    MOCK_OPS_TOKEN: "${MOCK_OPS_TOKEN}"         # raw token for mock-platform auth
  depends_on: [trading-mock-platform]
  expose: ["8080"]
  networks: [trading]
```

**Overrides for existing services:**

```yaml
ingress:
  environment:
    TRADING_PLATFORM_INTEGRATION: backtester
    BACKTESTER_API_URL: http://trading-backtester:8080
    LAB_BOT_RESULTS_INTEGRATION: http
    LAB_OPS_READ_URL: http://trading-mock-platform:8839
    LAB_OPS_READ_TOKEN: "${MOCK_OPS_TOKEN}"
    BACKTEST_BACKEND: research_platform
  depends_on:
    trading-backtester: { condition: service_started }

worker:  # same env overrides as ingress
  environment: (same as ingress)

office-server:
  environment:
    OFFICE_PLATFORM_ENABLED: "true"
    TRADING_PLATFORM_READ_URL: http://trading-mock-platform:8839
    TRADING_PLATFORM_READ_TOKEN: "${MOCK_OPS_TOKEN}"
```

**`.env.research-demo`** (committed to repo, no secrets):
```bash
# Full research-demo stack — all vars except tokens have safe defaults.
# Set MOCK_OPS_TOKENS and MOCK_OPS_TOKEN before running.
MOCK_OPS_TOKENS=<sha256-hex of your demo token>
MOCK_OPS_TOKEN=<raw demo token>

TRADING_LAB_READ_TOKEN=dev-read-token
TRADING_LAB_CHAT_TOKEN=dev-chat-token
TRADING_LAB_TASK_TOKEN=dev-task-token
TRADING_LAB_CALLBACK_TOKEN=dev-callback-token

# LLM keys — optional, leave blank for fake-adapter demo
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=

# Office ports
OFFICE_WEB_PORT=8080
OFFICE_SERVER_PORT=8787
```

### 3 — Capability failure: `research_platform.datasets_unavailable`

**Location:** `trading-lab/src/orchestrator/handlers/hypothesis-build.handler.ts`

When `backtestBackend === 'research_platform'`, guard before submit:

```typescript
const { datasets } = await services.researchPlatform.listDatasets();
if (datasets.length === 0) {
  await services.events.append(
    event(task.id, 'research_platform.datasets_unavailable', {
      reason: 'no datasets returned — research platform may be misconfigured or data source unavailable',
    })
  );
  await services.builds.markBuildFailed(buildId, [
    { code: 'datasets_unavailable', severity: 'error', path: '', message: 'No datasets available from research platform' },
  ]);
  return;
}
```

**Test coverage** in `hypothesis-build.platform.handler.test.ts`:
- `listDatasets()` returns `{ datasets: [] }` → emits `research_platform.datasets_unavailable` + `build_failed`
- Existing happy-path tests remain unchanged

The guard is placed _before_ `validateModule()` to fail fast without unnecessary platform calls when the data source is offline.

---

## Data Flow (end-to-end)

1. User sends hypothesis to lab chat
2. `worker` picks up `hypothesis.build` job
3. `hypothesisBuildHandler` (backend: `research_platform`):
   a. `listDatasets()` → `HttpBacktesterAdapter` → `GET /datasets` on backtester
   b. Backtester calls `MockPlatformDataPort.listDatasets()` → `GET /historical/coverage` on mock-platform
   c. If `[]` → emit `research_platform.datasets_unavailable`, done
   d. Continue: `validateModule()` → `submitOverlayRun()` → poll → result
4. `office-server` serves run status + results to `office-web`

---

## Environment Variable Map

| Variable | Service | Value in research-demo |
|----------|---------|----------------------|
| `TRADING_PLATFORM_INTEGRATION` | ingress/worker | `backtester` |
| `BACKTESTER_API_URL` | ingress/worker | `http://trading-backtester:8080` |
| `BACKTEST_BACKEND` | ingress/worker | `research_platform` |
| `LAB_BOT_RESULTS_INTEGRATION` | ingress/worker | `http` |
| `LAB_OPS_READ_URL` | ingress/worker | `http://trading-mock-platform:8839` |
| `LAB_OPS_READ_TOKEN` | ingress/worker | `${MOCK_OPS_TOKEN}` |
| `BACKTESTER_DATA_SOURCE` | trading-backtester | `mock` |
| `BACKTESTER_MOCK_PLATFORM_URL` | trading-backtester | `http://trading-mock-platform:8839` |
| `OFFICE_PLATFORM_ENABLED` | office-server | `true` |
| `TRADING_PLATFORM_READ_URL` | office-server | `http://trading-mock-platform:8839` |

---

## Done When

- `docker compose -f docker-compose.yml -f docker-compose.research-demo.yml --env-file .env.research-demo up --build` starts all 6 services (postgres, redis, ingress, worker, office-server, office-web) + mock-platform + backtester
- `curl http://localhost:8787/api/office/agents/statuses` returns `200`
- `curl http://localhost:8839/ops/discover` returns `200`
- `pnpm typecheck` passes in both `trading-lab` and `trading-backtester`
- `pnpm test` passes with new `research_platform.datasets_unavailable` test in `trading-lab`
- Roadmap Phase 010 marked `✅ DONE`
