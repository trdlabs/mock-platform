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
