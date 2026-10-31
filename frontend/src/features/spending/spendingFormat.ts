import type {
  ChargeKind,
  PaymentMethod,
  ReceiptEdit,
  SpendingDetail,
} from './spendingApi';

/** 2909, 'CAD' → '$29.09' (the currency code shown only when it isn't the
 * locale's own dollar, so a foreign receipt reads as one). */
export function formatMoney(cents: number, currency: string | null = null): string {
  const amount = cents / 100;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return amount.toLocaleString(undefined, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      });
    } catch {
      // An unknown code: plain number + code below.
    }
  }
  const s = Math.abs(amount).toFixed(2);
  return `${amount < 0 ? '−' : ''}$${s}${currency ? ` ${currency}` : ''}`;
}

/** '2026-10-28T17:42' → 'Oct 28, 2026' (date only; null → ''). */
export function formatDay(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const units = (cents: number | null) => (cents == null ? '' : (cents / 100).toFixed(2));

/** '4.99', '$4.99', '-1.20' → 4.99; '' → null; junk → NaN. */
export function parseAmount(text: string): number | null {
  const t = text.trim().replace(/[$,\s]/g, '').replace('−', '-');
  if (!t) return null;
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}

/** The editable form: every amount a string, as typed. */
export interface ReceiptDraft {
  storeName: string;
  storeAddress: string;
  date: string;
  currency: string;
  lines: { rawText: string; qty: string; lineTotal: string }[];
  charges: { kind: ChargeKind; name: string; amount: string; lineIndex: number | null }[];
  subtotal: string;
  total: string;
  method: PaymentMethod;
  cardBrand: string;
  lastFour: string;
}

export function toDraft(tx: SpendingDetail): ReceiptDraft {
  return {
    storeName: tx.store ?? '',
    storeAddress: tx.storeAddress ?? '',
    date: tx.datetime ?? '',
    currency: tx.currency ?? '',
    lines: tx.lineItems.map((l) => ({
      rawText: l.rawText,
      qty: l.qty == null ? '' : String(l.qty),
      lineTotal: units(l.lineTotalCents),
    })),
    charges: tx.charges.map((c) => ({
      kind: c.kind,
      name: c.name ?? '',
      amount: units(c.amountCents),
      lineIndex: c.lineIndex,
    })),
    subtotal: units(tx.subtotalCents),
    total: units(tx.amountCents),
    method: tx.payment?.method ?? 'other',
    cardBrand: tx.payment?.cardBrand ?? '',
    lastFour: tx.payment?.lastFour ?? '',
  };
}

const orNull = (s: string) => s.trim() || null;

/**
 * The approve body from an edited form, or the reason it can't be sent.
 * Blank lines and charges are dropped; unit price and tendered/change
 * aren't edited here and go back as they were read.
 */
export function fromDraft(
  draft: ReceiptDraft,
  tx: SpendingDetail,
  unmapped: string[],
): { receipt: ReceiptEdit } | { error: string } {
  const total = parseAmount(draft.total);
  if (total == null || Number.isNaN(total)) return { error: 'The total must be a number.' };
  const subtotal = parseAmount(draft.subtotal);
  if (Number.isNaN(subtotal)) return { error: 'The subtotal must be a number or empty.' };

  // Keep each kept line's original index so charges stay under it.
  const keptIndex = new Map<number, number>();
  const lines: ReceiptEdit['line_items'] = [];
  for (const [i, l] of draft.lines.entries()) {
    if (!l.rawText.trim() && !l.lineTotal.trim()) continue;
    const amount = parseAmount(l.lineTotal);
    if (amount == null || Number.isNaN(amount))
      return { error: `Line ${i + 1} needs an amount.` };
    const qty = parseAmount(l.qty);
    if (Number.isNaN(qty)) return { error: `Line ${i + 1}: the quantity must be a number.` };
    keptIndex.set(i, lines.length);
    const unitCents = tx.lineItems[i]?.unitPriceCents ?? null;
    lines.push({
      raw_text: l.rawText.trim() || '(unnamed)',
      qty,
      unit_price: unitCents == null ? null : unitCents / 100,
      line_total: amount,
    });
  }
  if (lines.length === 0) return { error: 'A receipt needs at least one line.' };

  const charges: ReceiptEdit['charges'] = [];
  for (const [i, c] of draft.charges.entries()) {
    if (!c.name.trim() && !c.amount.trim()) continue;
    const amount = parseAmount(c.amount);
    if (amount == null || Number.isNaN(amount))
      return { error: `Charge ${c.name || i + 1} needs an amount.` };
    const original = tx.charges[i];
    charges.push({
      kind: c.kind,
      name: orNull(c.name),
      raw_text: original?.rawText ?? null,
      amount,
      rate: original?.rate ?? null,
      line_index: c.lineIndex == null ? null : (keptIndex.get(c.lineIndex) ?? null),
    });
  }

  const p = tx.payment;
  return {
    receipt: {
      store: { name: orNull(draft.storeName), address: orNull(draft.storeAddress), store_number: null },
      datetime: orNull(draft.date),
      currency: orNull(draft.currency.toUpperCase()),
      line_items: lines,
      charges,
      subtotal,
      total,
      payment: {
        method: draft.method,
        card_brand: draft.method === 'card' ? orNull(draft.cardBrand) : null,
        last_four: draft.method === 'card' ? orNull(draft.lastFour) : null,
        tendered: p?.tenderedCents == null ? null : p.tenderedCents / 100,
        change: p?.changeCents == null ? null : p.changeCents / 100,
      },
      unmapped,
    },
  };
}

/** Did the user change anything? (Approving untouched sends no edits.) */
export function draftChanged(a: ReceiptDraft, b: ReceiptDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
