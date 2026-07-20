// SDK SEAM — the ONLY historical contract file permitted to import @trdlabs/sdk
// (machine-enforced by scripts/verify_contract_isolation.ts). CanonicalRowV2 is the platform's
// frozen on-disk row contract (010/028); this file re-exports it verbatim so the mock serves the
// SAME type as the real platform. Every other contract file MUST stay dependency-free.
export type { CanonicalRowV2 } from '@trdlabs/sdk/historical';
