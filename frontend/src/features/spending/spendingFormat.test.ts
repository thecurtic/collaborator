import { describe, expect, it } from 'vitest';
import type { SpendingDetail } from './spendingApi';
import { draftChanged, formatDay, formatMoney, fromDraft, parseAmount, toDraft } from './spendingFormat';

const TX: SpendingDetail = {
  id: 1,
  status: 'pending',
  datetime: '2026-10-28T17:42',
  currency: 'CAD',
  amountCents: 2909,
  subtotalCents: 2867,
  store: 'Safeway',
  storeAddress: 'Kingsway',
  review: ['new charge: GST'],
  createdAt: '2026-10-28 17:50:00',
  lineItems: [
    { rawText: 'CLASSICO TOM BASIL', qty: 1, unitPriceCents: 499, lineTotalCents: 499 },
    { rawText: 'KICKING HORSE 454G', qty: 1, unitPriceCents: 1549, lineTotalCents: 1549 },
    { rawText: 'SPARKLING WTR 12PK', qty: 1, unitPriceCents: 699, lineTotalCents: 699 },
  ],
  charges: [
    { kind: 'deposit', name: 'Bottle deposit', rawText: 'DEP', amountCents: 120, rate: null, known: false, lineIndex: 2 },
    { kind: 'tax', name: 'GST', rawText: 'GST 5%', amountCents: 42, rate: 0.05, known: false, lineIndex: null },
  ],
  payment: { method: 'card', cardBrand: 'Visa', lastFour: '1234', tenderedCents: null, changeCents: null },
  evidence: [],
};

describe('parseAmount', () => {
  it('reads what people type', () => {
    expect(parseAmount('4.99')).toBe(4.99);
    expect(parseAmount(' $1,234.50 ')).toBe(1234.5);
    expect(parseAmount('−1.20')).toBe(-1.2);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('4.9.9')).toBeNaN();
    expect(parseAmount('abc')).toBeNaN();
  });
});

describe('formatting', () => {
  it('formats money and days', () => {
    expect(formatMoney(2909, null)).toBe('$29.09');
    expect(formatMoney(-30, null)).toBe('−$0.30');
    expect(formatMoney(2909, 'CAD')).toContain('29.09');
    expect(formatDay(null)).toBe('');
    expect(formatDay('2026-10-28T17:42')).toContain('2026');
  });
});

describe('draft round trip', () => {
  it('sends back what was read when nothing changed', () => {
    const d = toDraft(TX);
    expect(draftChanged(d, toDraft(TX))).toBe(false);
    const out = fromDraft(d, TX, []);
    if (!('receipt' in out)) throw new Error(out.error);
    expect(out.receipt.total).toBe(29.09);
    expect(out.receipt.subtotal).toBe(28.67);
    expect(out.receipt.line_items[1]).toEqual({
      raw_text: 'KICKING HORSE 454G', qty: 1, unit_price: 15.49, line_total: 15.49,
    });
    expect(out.receipt.charges[0]).toMatchObject({ kind: 'deposit', amount: 1.2, line_index: 2 });
    expect(out.receipt.payment).toMatchObject({ method: 'card', card_brand: 'Visa', last_four: '1234' });
  });

  it('keeps a charge under its line when an earlier line is cleared', () => {
    const d = toDraft(TX);
    d.lines[0] = { rawText: '', qty: '', lineTotal: '' };
    const out = fromDraft(d, TX, []);
    if (!('receipt' in out)) throw new Error(out.error);
    expect(out.receipt.line_items).toHaveLength(2);
    expect(out.receipt.charges[0].line_index).toBe(1);
  });

  it('refuses what the server would', () => {
    const d = toDraft(TX);
    expect(fromDraft({ ...d, total: '' }, TX, [])).toEqual({ error: 'The total must be a number.' });
    expect(fromDraft({ ...d, subtotal: 'x' }, TX, [])).toHaveProperty('error');
    expect(fromDraft({ ...d, lines: [] }, TX, [])).toEqual({ error: 'A receipt needs at least one line.' });
    const bad = toDraft(TX);
    bad.lines[1].lineTotal = '';
    expect(fromDraft(bad, TX, [])).toEqual({ error: 'Line 2 needs an amount.' });
  });

  it('drops card details for other methods', () => {
    const d = { ...toDraft(TX), method: 'cash' as const };
    const out = fromDraft(d, TX, []);
    if (!('receipt' in out)) throw new Error(out.error);
    expect(out.receipt.payment).toMatchObject({ method: 'cash', card_brand: null, last_four: null });
  });
});
