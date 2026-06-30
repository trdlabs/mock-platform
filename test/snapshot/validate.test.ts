import { describe, it, expect } from 'vitest';
import { assertValidManifest, assertValidBundle } from '../../src/snapshot/validate.js';

const versions = {
  snapshotSchemaVersion: 'snapshot.1', opsReadContractVersion: 'ops.5',
  researchReadContractVersion: 'research.1', analysisContractVersion: 'ops.4',
  exporterVersion: 'e', sourcePlatformCommit: 'x', redactionPolicyVersion: 'r',
};
const manifest = { ref: 't', createdAtMs: 1, bundleRef: 'ops/bundle.json', checksumsRef: 'checksums.json', versions };
const emptyBundle = {
  runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {}, tradeEvidenceByTrade: {},
  runtimeHealth: { entries: [], asOf: 1 },
  marketHealth: { status: 'ok', diagnostics: {}, streamAgeMs: null, availability: 'available', asOf: 1 },
  executionHealth: { status: 'ok', recentCounts: {}, lastEventMs: null, availability: 'unavailable', asOf: 1 },
  coverage: { entries: [], availability: 'available', asOf: 1 },
  analysisByRun: {}, researchByRun: {}, replay: { frames: [] },
};

describe('snapshot schema validation', () => {
  it('accepts a well-formed manifest and bundle', () => {
    expect(() => assertValidManifest(manifest)).not.toThrow();
    expect(() => assertValidBundle(emptyBundle)).not.toThrow();
  });
  it('FAILS CLOSED on an unknown field in the manifest', () => {
    expect(() => assertValidManifest({ ...manifest, leaked: 'x' })).toThrow(/manifest failed schema/i);
  });
  it('FAILS CLOSED on an unknown field in the bundle', () => {
    expect(() => assertValidBundle({ ...emptyBundle, leaked: 'x' })).toThrow(/bundle failed schema/i);
  });
  it('FAILS CLOSED on an unknown field inside a run record', () => {
    const bad = { ...emptyBundle, runs: [{
      runId: 'r1', mode: 'live', status: 'running', strategy: { name: 's', version: '1' },
      startedAtMs: 1, finishedAtMs: null, lastSeenMs: 2, symbols: [], hostPath: '/home/op/x' }] };
    expect(() => assertValidBundle(bad)).toThrow(/bundle failed schema/i);
  });
  it('accepts a fully-populated tradeEvidenceByTrade entry (positive)', () => {
    const bundle = {
      ...emptyBundle,
      tradeEvidenceByTrade: {
        t1: {
          tradeId: 't1', runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
          openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09',
          realizedPnl: '-1', pnlPct: '-10', closeReason: 'stop_loss', closeReasonRaw: 'hard_stop',
          lifecycle: [{ tsMs: 1, type: 'entry', price: '0.1', qty: '5', note: null }],
        },
      },
    };
    expect(() => assertValidBundle(bundle)).not.toThrow();
  });
  it('FAILS CLOSED on a tradeLifecycleEvent missing required price field (negative)', () => {
    const bad = {
      ...emptyBundle,
      tradeEvidenceByTrade: {
        t1: {
          tradeId: 't1', runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
          openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09',
          realizedPnl: '-1', pnlPct: '-10', closeReason: 'stop_loss', closeReasonRaw: 'hard_stop',
          lifecycle: [{ tsMs: 1, type: 'entry', qty: '5' }],
        },
      },
    };
    expect(() => assertValidBundle(bad)).toThrow(/bundle failed schema/i);
  });
  it('FAILS CLOSED on a tradeEvidence with a raw (non-canonical) closeReason value', () => {
    const bad = {
      ...emptyBundle,
      tradeEvidenceByTrade: {
        t1: {
          tradeId: 't1', runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
          openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09',
          realizedPnl: '-1', pnlPct: '-10', closeReason: 'tp2', closeReasonRaw: 'tp2',
          lifecycle: [],
        },
      },
    };
    expect(() => assertValidBundle(bad)).toThrow(/bundle failed schema/i);
  });
});
