// Чистый маппер canonical → ops trade-evidence (зеркало get-trade-evidence.ts платформы).
// Используется экспортёром fetch-snapshot; не импортирует pg и не делает IO.

export type OpsLifecycleType = 'entry' | 'dca' | 'tp' | 'sl' | 'exit' | 'stop_update';

export interface EvidenceLifecycleRow {
  readonly tradeId: string;
  readonly eventType: string;
  readonly tsMs: number;
  readonly fillPrice: string | null;
  readonly triggerPrice: string | null;
  readonly qty: string | null;
  readonly reason: string | null;
}

export interface EvidenceTradeRow {
  readonly tradeId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly realizedPnl: string;
  readonly pnlPct: string;
  readonly closeReason: string | null;
}

export interface LifecycleEvt {
  readonly tsMs: number;
  readonly type: OpsLifecycleType;
  readonly price: string | null;
  readonly qty: string | null;
  readonly note: string | null;
}

export interface TradeEvidenceOut extends EvidenceTradeRow {
  readonly lifecycle: LifecycleEvt[];
}

/** canonical event_type → ops lifecycle-тип; null для неизвестного (defensive skip). */
export function mapEventType(eventType: string): OpsLifecycleType | null {
  switch (eventType) {
    case 'trade_opened': return 'entry';
    case 'trade_scaled_in': return 'dca';
    case 'tp1_armed':
    case 'tp_armed': return 'tp';
    case 'trade_closed': return 'exit';
    default: return null;
  }
}

export function toLifecycleEvent(ev: EvidenceLifecycleRow): LifecycleEvt | null {
  const type = mapEventType(ev.eventType);
  if (type === null) return null;
  // arm-события (tp) несут trigger_price, fill-события — fill_price.
  const price = type === 'tp' ? ev.triggerPrice : ev.fillPrice;
  return { tsMs: ev.tsMs, type, price: price ?? null, qty: ev.qty ?? null, note: ev.reason ?? null };
}

export function buildTradeEvidenceByTrade(
  tradeRows: readonly EvidenceTradeRow[],
  lifecycleRows: readonly EvidenceLifecycleRow[],
): Record<string, TradeEvidenceOut> {
  const byTrade = new Map<string, LifecycleEvt[]>();
  for (const r of lifecycleRows) {
    const evt = toLifecycleEvent(r);
    if (evt === null) continue;
    if (!byTrade.has(r.tradeId)) byTrade.set(r.tradeId, []);
    byTrade.get(r.tradeId)!.push(evt);
  }
  const out: Record<string, TradeEvidenceOut> = {};
  for (const t of tradeRows) {
    out[t.tradeId] = {
      tradeId: t.tradeId, runId: t.runId, symbol: t.symbol, side: t.side,
      openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      realizedPnl: t.realizedPnl, pnlPct: t.pnlPct, closeReason: t.closeReason,
      lifecycle: byTrade.get(t.tradeId) ?? [],
    };
  }
  return out;
}
