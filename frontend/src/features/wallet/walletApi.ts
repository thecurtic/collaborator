import { request } from '@/api/http';

/** One outgoing payment from the ledger (wallet_spends). */
export interface WalletSpend {
  createdAt: string;
  amountSats: number;
  feesSats: number;
  reason: string | null;
  status: 'paid' | 'unconfirmed';
  /** 'model' = Collaborator paid it; 'user' = sent from this screen. */
  source: 'model' | 'user';
}

export interface WalletSummary {
  configured: boolean;
  provider?: string;
  canPay?: boolean;
  balanceSats?: number;
  /** The model's spending today and its daily cap (the user's sends don't count). */
  spentTodaySats?: number;
  dailyCapSats?: number;
  recent: WalletSpend[];
  /** The wallet couldn't be asked for its balance. */
  error?: string;
}

export interface DecodedInvoice {
  invoice: string;
  amountSats: number | null;
  description: string | null;
  expiresAt?: number;
  expired?: boolean;
}

export interface ReceivedInvoice {
  amountSats: number;
  invoice: string;
  paymentHash: string;
}

export type SendResult =
  | { status: 'paid'; amountSats: number; feesSats: number; alreadyPaid: boolean }
  | { status: 'unconfirmed'; detail: string };

interface ApiSpend {
  created_at: string;
  amount_sats: number;
  fees_sats: number;
  reason: string | null;
  status: 'paid' | 'unconfirmed';
  source: 'model' | 'user';
}

interface ApiSummary {
  configured: boolean;
  provider?: string;
  can_pay?: boolean;
  balance_sats?: number;
  spent_today_sats?: number;
  daily_cap_sats?: number;
  recent?: ApiSpend[];
  error?: string;
}

export const walletApi = {
  async summary(): Promise<WalletSummary> {
    const r = await request<ApiSummary>('/api/wallet');
    return {
      configured: r.configured,
      provider: r.provider,
      canPay: r.can_pay,
      balanceSats: r.balance_sats,
      spentTodaySats: r.spent_today_sats,
      dailyCapSats: r.daily_cap_sats,
      error: r.error,
      recent: (r.recent ?? []).map((s) => ({
        createdAt: s.created_at,
        amountSats: s.amount_sats,
        feesSats: s.fees_sats,
        reason: s.reason,
        status: s.status,
        source: s.source,
      })),
    };
  },

  async decode(invoice: string): Promise<DecodedInvoice> {
    const r = await request<{
      invoice: string;
      amount_sats: number | null;
      description: string | null;
      expires_at?: number;
      expired?: boolean;
    }>('/api/wallet/decode', { method: 'POST', body: JSON.stringify({ invoice }) });
    return {
      invoice: r.invoice,
      amountSats: r.amount_sats,
      description: r.description,
      expiresAt: r.expires_at,
      expired: r.expired,
    };
  },

  async send(invoice: string): Promise<SendResult> {
    const r = await request<{
      status: 'paid' | 'unconfirmed';
      amount_sats?: number;
      fees_sats?: number;
      already_paid?: boolean;
      detail?: string;
    }>('/api/wallet/send', { method: 'POST', body: JSON.stringify({ invoice }) });
    return r.status === 'paid'
      ? {
          status: 'paid',
          amountSats: r.amount_sats ?? 0,
          feesSats: r.fees_sats ?? 0,
          alreadyPaid: !!r.already_paid,
        }
      : { status: 'unconfirmed', detail: r.detail ?? '' };
  },

  async receive(amountSats: number, memo?: string): Promise<ReceivedInvoice> {
    const r = await request<{ amount_sats: number; invoice: string; payment_hash: string }>(
      '/api/wallet/receive',
      { method: 'POST', body: JSON.stringify({ amount_sats: amountSats, memo: memo || null }) },
    );
    return { amountSats: r.amount_sats, invoice: r.invoice, paymentHash: r.payment_hash };
  },

  /** true / false, or null when the wallet couldn't be asked. */
  async invoicePaid(paymentHash: string): Promise<boolean | null> {
    const r = await request<{ paid: boolean | null }>(`/api/wallet/invoices/${paymentHash}`);
    return r.paid;
  },
};
