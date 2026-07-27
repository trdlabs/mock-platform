import { describe, it, expect } from 'vitest';
import { rankWfoSymbols, canonicalTurnover, selectWfoWindow } from '../../scripts/wfo-select.js';

const M = 60_000;
const DAY = 86_400_000;

describe('rankWfoSymbols', () => {
  it('puts primary first, then top-N by turnover desc, ties symbol ASC', () => {
    const t = { HUSDT: 1, ZUSDT: 100, AUSDT: 50, BUSDT: 50, CUSDT: 10 };
    // excl HUSDT, top-3: ZUSDT(100), then AUSDT/BUSDT tie(50)→ASC, so AUSDT, BUSDT
    expect(rankWfoSymbols(t, 'HUSDT', 3)).toEqual(['HUSDT', 'ZUSDT', 'AUSDT', 'BUSDT']);
  });
  it('includes the primary even if it has no turnover entry', () => {
    expect(rankWfoSymbols({ ZUSDT: 9, AUSDT: 8 }, 'HUSDT', 1)).toEqual(['HUSDT', 'ZUSDT']);
  });
});

describe('canonicalTurnover', () => {
  it('serialises with keys sorted, so the hash is order-independent', () => {
    expect(canonicalTurnover({ B: 2, A: 1 })).toBe(canonicalTurnover({ A: 1, B: 2 }));
    expect(canonicalTurnover({ B: 2, A: 1 })).toBe('{"A":1,"B":2}');
  });
});

describe('selectWfoWindow', () => {
  const probeFrom = 0;
  const probeTo = 3 * DAY;
  const dense = (): Record<string, { minute_ts: number }[]> => {
    const g = Array.from({ length: (probeTo - probeFrom) / M }, (_, i) => probeFrom + i * M);
    return { A: g.map((t) => ({ minute_ts: t })), B: g.map((t) => ({ minute_ts: t })) };
  };
  it('returns the freshest 1-day window that fits within budget', () => {
    expect(selectWfoWindow(dense(), ['A', 'B'], probeFrom, probeTo, 1, 0, 0)).toEqual({ fromMs: 2 * DAY, toMs: 3 * DAY });
  });
  it('returns null when no window fits the budget', () => {
    const r = dense();
    r.B = r.B!.filter((_, i) => i % 10_000 === 0); // B nearly empty → intersection tiny
    expect(selectWfoWindow(r, ['A', 'B'], probeFrom, probeTo, 1, 5, 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty intersection is not a "narrow window" — it is no window at all.
//
// The two budgets answer "how much of this window is missing"; neither answers
// "is anything here". With an empty grid `totalGap` and `maxConsecutiveGap`
// both report the full span, so ordinary budgets do reject it — but a budget
// wide enough to tolerate the span (an operator loosening it to "just get a
// window") turns the check off entirely and the selector hands back a window
// over which no symbol shares a single minute. That window then flows into
// make-wfo-fixture, which writes a fixture with zero rows and records
// commonGridSize: 0 as if it were a result.
// ---------------------------------------------------------------------------
describe('selectWfoWindow: an empty common grid is never a window', () => {
  const MIN = 60_000;
  const DAY = 86_400_000;

  it('returns null for disjoint symbols even when the budgets would tolerate the whole span', () => {
    // A on even minutes of day 0, B on odd minutes of day 1 — no shared minute anywhere.
    const rows = {
      A: Array.from({ length: 100 }, (_, i) => ({ minute_ts: i * 2 * MIN })),
      B: Array.from({ length: 100 }, (_, i) => ({ minute_ts: DAY + (i * 2 + 1) * MIN })),
    };
    const win = selectWfoWindow(rows, ['A', 'B'], 0, 3 * DAY, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(win).toBeNull();
  });

  it('still returns a window when the symbols genuinely share minutes', () => {
    const rows = {
      A: Array.from({ length: 1440 }, (_, i) => ({ minute_ts: i * MIN })),
      B: Array.from({ length: 1440 }, (_, i) => ({ minute_ts: i * MIN })),
    };
    const win = selectWfoWindow(rows, ['A', 'B'], 0, DAY, 1, 0, 0);
    expect(win).toEqual({ fromMs: 0, toMs: DAY });
  });
});
