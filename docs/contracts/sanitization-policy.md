# Sanitization Policy

This document describes how raw platform data is transformed into a sanitized snapshot
bundle that is safe to commit to git, bake into a Docker image, and serve to downstream
consumers (trading-office, trading-lab) in demo and research environments.

Sanitization is a **two-layer** model:

1. **Operator-side projection (allowlist / default-deny)** — the exporter (out of scope
   in this repo) runs next to the private `trading-platform` and applies a strict
   allowlist before writing the bundle. Only fields explicitly named in the allowlist
   exist in the output.

2. **Runtime defense-in-depth (secret scan)** — `src/safety/secret-scan.ts` re-scans
   the already-sanitized bundle at load time as a defense-in-depth check. If any
   forbidden pattern is found, startup fails closed.

---

## Layer 1: Operator-side allowlist (exporter responsibility)

The exporter applies a **default-deny projection**: every output field must be
explicitly listed in the allowlist. Fields not in the allowlist do not appear in the
bundle at all — they are silently dropped, not replaced with a placeholder.

### Fields that must never reach the bundle

The following categories of data are absolutely forbidden in the output, regardless of
how they appear in the raw source:

| Category | Examples |
|----------|---------|
| Credentials & secrets | API keys, secret keys, tokens, passwords, HMAC secrets, private keys |
| Exchange internals | Raw order IDs, exchange-assigned execution IDs, venue account IDs |
| Database schema | Table names, column names, internal row IDs, migration markers |
| Host / infrastructure paths | Filesystem paths (`/home/op/...`), container IDs, IP addresses of prod infra |
| Account identifiers | Exchange account IDs, sub-account IDs, UID fields from any venue |
| Private configuration | Bot config fields not on the research allowlist, strategy parameter values not cleared for export |
| Live position state | Open positions, current PnL, unrealized P&L, margin utilization |

### Allowlisted fields (what may appear)

Only the fields described in `src/contract/snapshot/bundle.ts` and the referenced DTO
types (`BotRunRecord`, `ClosedTrade`, `OperationalEvent`, `DecisionLogEntry`, health
snapshots, coverage entries, `AnalysisSnapshot`, `ResearchRunResult`) may be present in
the bundle. The AJV schema enforces this at the runtime layer: any extra field on a
fixed-shape object causes startup to fail closed (`additionalProperties: false`).

Capability-aware absent fields (`{ "available": false, "reason": "..." }`) are the
correct encoding when a field is defined in the schema but cannot be safely sourced
(e.g. `strategyConfig`, `dcaCount`, `slTpBeEvents`).

---

## Layer 2: Runtime secret scan (`src/safety/secret-scan.ts`)

After the exporter has already applied the allowlist, the mock performs a second pass
over the serialized bundle text before any request is served.

### Scan patterns (blocklist)

The following patterns trigger a fail-closed startup error:

| Pattern | Reason |
|---------|--------|
| `-----BEGIN` | PEM-encoded key or certificate block |
| `sk_live_`, `pk_live_` | Stripe live-mode API keys |
| `AKIA`, `ABIA`, `ASIA` (followed by uppercase alphanum) | AWS IAM access key IDs |
| `xoxb-`, `xoxp-`, `xoxa-` | Slack bot/user/app tokens |
| `ghp_`, `gho_`, `ghs_`, `ghr_` | GitHub personal/OAuth/Actions/refresh tokens |
| Long hex strings matching known secret shapes | Captured by length + entropy heuristics |
| `/home/`, `/root/`, `/var/`, `/etc/`, `/opt/` | Host filesystem path leaks |

This list is intentionally conservative and can be extended. A false positive (a safe
string that matches a pattern) surfaces at startup and must be resolved by the operator.

### Scan scope

The scan runs over `JSON.stringify(bundle)` — the entire bundle serialized as a single
string — before any parsing or field-level access. This ensures that nested or
dynamically structured fields (e.g. `diagnostics`, `strategyConfig` when present as a
capable value) are also scanned.

### Fail-closed semantics

If any pattern matches, the mock logs the offending pattern name and aborts startup
with a non-zero exit code. No requests are served. The error message does NOT echo the
matched text (to avoid re-leaking it to logs).

---

## Responsibility boundary

The exporter/sanitizer is **operator-side** and out of scope for this repository. This
repo ships the loader, the schema validator, and the runtime secret scan — not the tool
that produces sanitized snapshots. Operators running against real platform data must run
their own sanitization pipeline using the allowlist policy above before producing a
bundle for use with this mock.
