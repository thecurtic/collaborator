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

/** A product a line is labelled with (matched in the background). */
export interface SpendingProduct {
  id: number;
  name: string;
  brand: string | null;
  category: string | null;
}

/** How a line got its label; null = not labelled yet. */
export type LineMatch = 'alias' | 'model' | 'chat' | 'unsure' | 'user' | null;

export interface SpendingLine {
  id: number;
  rawText: string;
  qty: number | null;
  unitPriceCents: number | null;
  lineTotalCents: number;
  match: LineMatch;
  product: SpendingProduct | null;
}

/** A label worth a second look (the "check these labels" list). */
export interface UnsureLine {
  id: number;
  rawText: string;
  lineTotalCents: number;
  transactionId: number;
  datetime: string | null;
  store: string | null;
  product: SpendingProduct | null;
}

export interface SpendingCategory {
  id: number;
  name: string;
  parentId: number | null;
}

/** A correction: an existing product, or a new one. */
export type LineLabel =
  | { productId: number }
  | { new: { name: string; brand: string | null; category: string | null } };

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
    id: number;
    raw_text: string;
    qty: number | null;
    unit_price_cents: number | null;
    line_total_cents: number;
    match: LineMatch;
    product: SpendingProduct | null;
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
    id: l.id,
    rawText: l.raw_text,
    qty: l.qty,
    unitPriceCents: l.unit_price_cents,
    lineTotalCents: l.line_total_cents,
    match: l.match ?? null,
    product: l.product ?? null,
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

  async unsureLabels(): Promise<UnsureLine[]> {
    const r = await request<{
      lines: {
        id: number;
        raw_text: string;
        line_total_cents: number;
        transaction_id: number;
        datetime: string | null;
        store: string | null;
        product_id: number | null;
        product: string | null;
        brand: string | null;
        category: string | null;
      }[];
    }>('/api/spending/labels/unsure');
    return r.lines.map((l) => ({
      id: l.id,
      rawText: l.raw_text,
      lineTotalCents: l.line_total_cents,
      transactionId: l.transaction_id,
      datetime: l.datetime,
      store: l.store,
      product: l.product_id == null ? null
        : { id: l.product_id, name: l.product ?? '', brand: l.brand, category: l.category },
    }));
  },

  async searchProducts(q: string): Promise<SpendingProduct[]> {
    const r = await request<{ products: SpendingProduct[] }>(
      `/api/spending/products?q=${encodeURIComponent(q)}`,
    );
    return r.products;
  },

  async categories(): Promise<SpendingCategory[]> {
    const r = await request<{ categories: { id: number; name: string; parent_id: number | null }[] }>(
      '/api/spending/categories',
    );
    return r.categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id }));
  },

  /** The user's label for a line; lines printed the same way follow. */
  async correctLine(id: number, label: LineLabel): Promise<void> {
    await request(`/api/spending/lines/${id}/product`, {
      method: 'PUT',
      body: JSON.stringify('productId' in label ? { product_id: label.productId } : { new: label.new }),
    });
  },

  async evidenceImage(id: number): Promise<Blob> {
    const res = await requestStream(`/api/spending/evidence/${id}/image`);
    return res.blob();
  },
};
