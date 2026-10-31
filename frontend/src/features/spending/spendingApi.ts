import { request, requestStream } from '@/api/http';

/** One purchase (API-SPEC §30). Amounts are integer cents. */
export interface SpendingTransaction {
  id: number;
  status: 'pending' | 'committed';
  datetime: string | null;
  currency: string | null;
  amountCents: number;
  subtotalCents: number | null;
  store: string | null;
  storeAddress: string | null;
  /** Why it awaits the user (empty once committed). */
  review: string[];
  createdAt: string;
}

export interface SpendingLine {
  rawText: string;
  qty: number | null;
  unitPriceCents: number | null;
  lineTotalCents: number;
}

export const CHARGE_KINDS = [
  'tax', 'fee', 'deposit', 'discount', 'rounding', 'tip', 'other',
] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export interface SpendingCharge {
  kind: ChargeKind;
  name: string | null;
  rawText: string | null;
  amountCents: number;
  rate: number | null;
  /** A charge type approved before (unknown ones are flagged). */
  known: boolean;
  /** The line it's printed under, if any. */
  lineIndex: number | null;
}

export const PAYMENT_METHODS = ['cash', 'card', 'bitcoin', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface SpendingPayment {
  method: PaymentMethod;
  cardBrand: string | null;
  lastFour: string | null;
  tenderedCents: number | null;
  changeCents: number | null;
}

export interface SpendingEvidence {
  id: number;
  type: string;
  caption: string | null;
  role: 'origin' | 'confirms';
  capturedAt: string;
  unmapped: string[];
}

export interface SpendingDetail extends SpendingTransaction {
  lineItems: SpendingLine[];
  charges: SpendingCharge[];
  payment: SpendingPayment | null;
  evidence: SpendingEvidence[];
}

export type SpendingPeriod = 'week' | 'month' | 'year';

export interface SpendingTotal {
  period: SpendingPeriod;
  since: string;
  totals: { currency: string | null; totalCents: number; count: number }[];
}

/** Corrections sent on approve: the extraction's shape, amounts in units. */
export interface ReceiptEdit {
  store: { name: string | null; address: string | null; store_number: string | null };
  datetime: string | null;
  currency: string | null;
  line_items: { raw_text: string; qty: number | null; unit_price: number | null; line_total: number }[];
  charges: {
    kind: ChargeKind;
    name: string | null;
    raw_text: string | null;
    amount: number;
    rate: number | null;
    line_index: number | null;
  }[];
  subtotal: number | null;
  total: number;
  payment: {
    method: PaymentMethod;
    card_brand: string | null;
    last_four: string | null;
    tendered: number | null;
    change: number | null;
  };
  unmapped: string[];
}

interface ApiTransaction {
  id: number;
  status: 'pending' | 'committed';
  datetime: string | null;
  currency: string | null;
  amount_cents: number;
  subtotal_cents: number | null;
  store: string | null;
  store_address: string | null;
  review: string[];
  created_at: string;
}

interface ApiDetail extends ApiTransaction {
  line_items: {
    raw_text: string;
    qty: number | null;
    unit_price_cents: number | null;
    line_total_cents: number;
  }[];
  charges: {
    kind: ChargeKind;
    name: string | null;
    raw_text: string | null;
    amount_cents: number;
    rate: number | null;
    known: boolean;
    line_index: number | null;
  }[];
  payment: {
    method: PaymentMethod;
    card_brand: string | null;
    last_four: string | null;
    tendered_cents: number | null;
    change_cents: number | null;
  } | null;
  evidence: {
    id: number;
    type: string;
    caption: string | null;
    role: 'origin' | 'confirms';
    captured_at: string;
    unmapped: string[];
  }[];
}

const toTransaction = (t: ApiTransaction): SpendingTransaction => ({
  id: t.id,
  status: t.status,
  datetime: t.datetime,
  currency: t.currency,
  amountCents: t.amount_cents,
  subtotalCents: t.subtotal_cents,
  store: t.store,
  storeAddress: t.store_address,
  review: t.review ?? [],
  createdAt: t.created_at,
});

const toDetail = (t: ApiDetail): SpendingDetail => ({
  ...toTransaction(t),
  lineItems: t.line_items.map((l) => ({
    rawText: l.raw_text,
    qty: l.qty,
    unitPriceCents: l.unit_price_cents,
    lineTotalCents: l.line_total_cents,
  })),
  charges: t.charges.map((c) => ({
    kind: c.kind,
    name: c.name,
    rawText: c.raw_text,
    amountCents: c.amount_cents,
    rate: c.rate,
    known: c.known,
    lineIndex: c.line_index,
  })),
  payment: t.payment && {
    method: t.payment.method,
    cardBrand: t.payment.card_brand,
    lastFour: t.payment.last_four,
    tenderedCents: t.payment.tendered_cents,
    changeCents: t.payment.change_cents,
  },
  evidence: t.evidence.map((e) => ({
    id: e.id,
    type: e.type,
    caption: e.caption,
    role: e.role,
    capturedAt: e.captured_at,
    unmapped: e.unmapped ?? [],
  })),
});

export const spendingApi = {
  async list(status?: 'pending' | 'committed'): Promise<SpendingTransaction[]> {
    const q = status ? `?status=${status}` : '';
    const r = await request<{ items: ApiTransaction[] }>(`/api/spending/transactions${q}`);
    return r.items.map(toTransaction);
  },

  async get(id: number): Promise<SpendingDetail> {
    const r = await request<{ transaction: ApiDetail }>(`/api/spending/transactions/${id}`);
    return toDetail(r.transaction);
  },

  async total(period: SpendingPeriod): Promise<SpendingTotal> {
    const r = await request<{
      period: SpendingPeriod;
      since: string;
      totals: { currency: string | null; total_cents: number; count: number }[];
    }>(`/api/spending/total?period=${period}`);
    return {
      period: r.period,
      since: r.since,
      totals: r.totals.map((t) => ({
        currency: t.currency,
        totalCents: t.total_cents,
        count: t.count,
      })),
    };
  },

  /** Commit a pending transaction, with corrections when given. */
  async approve(id: number, receipt?: ReceiptEdit): Promise<SpendingDetail> {
    const r = await request<{ transaction: ApiDetail }>(
      `/api/spending/transactions/${id}/approve`,
      { method: 'POST', body: JSON.stringify(receipt ? { receipt } : {}) },
    );
    return toDetail(r.transaction);
  },

  async discard(id: number): Promise<void> {
    await request(`/api/spending/transactions/${id}`, { method: 'DELETE' });
  },

  async evidenceImage(id: number): Promise<Blob> {
    const res = await requestStream(`/api/spending/evidence/${id}/image`);
    return res.blob();
  },
};
