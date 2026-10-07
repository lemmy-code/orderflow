import { OrderItemLine, PricedLine, RejectionReason } from '@app/contracts';

export interface StockRow {
  id: string;
  stockAvailable: number;
  priceCents: number;
}

export type ReserveDecision = { ok: true; lines: PricedLine[] } | { ok: false; reason: RejectionReason };

/** Sums repeated products (the API forbids them, but other producers might not) and sorts by id for lock order. */
export function aggregate(items: OrderItemLine[]): OrderItemLine[] {
  const totals = new Map<string, number>();
  for (const i of items) totals.set(i.productId, (totals.get(i.productId) ?? 0) + i.quantity);
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, quantity]) => ({ productId, quantity }));
}

export function decideReservation(items: OrderItemLine[], products: Map<string, StockRow>): ReserveDecision {
  const lines: PricedLine[] = [];
  let short = false;
  for (const i of items) {
    const p = products.get(i.productId);
    if (!p) return { ok: false, reason: 'UNKNOWN_PRODUCT' };
    if (p.stockAvailable < i.quantity) short = true;
    lines.push({ productId: i.productId, unitPriceCents: p.priceCents });
  }
  return short ? { ok: false, reason: 'INSUFFICIENT_STOCK' } : { ok: true, lines };
}
