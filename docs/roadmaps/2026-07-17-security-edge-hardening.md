# Security edge hardening — mock-platform-local roadmap entry (2026-07-17)

Canonical cross-repo status lives in the control-center
[initiative registry](../../../control-center/docs/delivery/cross-repo-initiatives.md)
and the
[security-edge-hardening card](../../../control-center/docs/delivery/initiatives/security-edge-hardening.md);
this file keeps only the mock-platform-local slice (registry rule: no plan
duplication).

Full audit: control-center
[`docs/analysis/08-security-boundary-audit.md`](../../../control-center/docs/analysis/08-security-boundary-audit.md).

## mock-platform's part — `proposed`

mock-platform is demo/dev-only and serves sanitized snapshot data, so the direct
impact is low. It is listed because the same code-shape ("trust decided by a
config string, enforced nowhere per request") is **critical** in the real
platform. Startup is already fail-closed on a non-loopback bind with an empty
allowlist, and the compose makes the token mandatory. Remaining items:

- `/historical/*` bypasses the token middleware entirely
  (`src/http/app.ts:86-104`) → put it behind the same `authorize` middleware (or
  gate it behind an explicit `MOCK_HISTORICAL_PUBLIC` flag).
- `docker-compose.mock.yml` publishes `8839` on all interfaces
  (`docker-compose.mock.yml:16-17`) → bind `127.0.0.1:8839` (office reaches it
  over the compose network).
- "loopback trust" is bind-time only, not a per-request peer check
  (`src/access/auth.ts:7`) → when the allowlist is empty, verify the socket peer
  is loopback, or log a prominent warning that any forwarder voids auth.
