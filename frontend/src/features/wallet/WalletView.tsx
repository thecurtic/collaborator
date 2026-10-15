import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ClipboardPaste,
  Copy,
  Loader2,
  RefreshCw,
  Wallet,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  walletApi,
  type DecodedInvoice,
  type ReceivedInvoice,
  type WalletSpend,
  type WalletSummary,
} from './walletApi';
import { QrCode } from './QrCode';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

const sats = (n: number) => `${n.toLocaleString()} sat${n === 1 ? '' : 's'}`;

const INPUT =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground ' +
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring sm:text-sm';

/**
 * Collaborator's own wallet, for the user: top it up (receive) and take money
 * out (send). The model's caps restrain the model only; what's sent from here
 * is recorded in the same ledger but never counted against them.
 */
export function WalletView() {
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<'receive' | 'send' | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSummary(await walletApi.summary());
      setError(null);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (summary === null && !error) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading wallet…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-4 py-4">
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        {summary && !summary.configured && (
          <div className="py-8 text-center text-muted-foreground">
            <Wallet className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p className="text-lg font-medium text-foreground">No wallet set up</p>
            <p className="mt-1 px-8 text-sm">
              Add Collaborator's wallet under <code>tools.wallet</code> in the
              server's config.yaml.
            </p>
          </div>
        )}

        {summary?.configured && (
          <>
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Balance</p>
                  <p className="mt-0.5 text-3xl font-semibold tabular-nums text-foreground">
                    {summary.balanceSats != null ? sats(summary.balanceSats) : '—'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Refresh balance"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                  className="-mr-2 -mt-1 shrink-0"
                >
                  <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              {summary.error && (
                <p className="mt-2 text-sm text-destructive">{summary.error}</p>
              )}
              {summary.dailyCapSats != null && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Collaborator has spent {sats(summary.spentTodaySats ?? 0)} of its{' '}
                  {sats(summary.dailyCapSats)} daily budget today.
                </p>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Button
                  variant={mode === 'receive' ? 'default' : 'secondary'}
                  onClick={() => setMode(mode === 'receive' ? null : 'receive')}
                >
                  <ArrowDownLeft className="mr-1.5 h-4 w-4" />
                  Receive
                </Button>
                <Button
                  variant={mode === 'send' ? 'default' : 'secondary'}
                  onClick={() => setMode(mode === 'send' ? null : 'send')}
                  disabled={!summary.canPay}
                >
                  <ArrowUpRight className="mr-1.5 h-4 w-4" />
                  Send
                </Button>
              </div>
              {!summary.canPay && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Receive only: this wallet has no spend key (admin_key).
                </p>
              )}
            </section>

            {mode === 'receive' && <ReceivePanel onPaid={() => void refresh()} />}
            {mode === 'send' && <SendPanel onSent={() => void refresh()} />}

            <RecentSpends spends={summary.recent} />
          </>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

/** Mint an invoice into Collaborator's wallet; watch until it's paid. */
function ReceivePanel({ onPaid }: { onPaid: () => void }) {
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<ReceivedInvoice | null>(null);
  const [paid, setPaid] = useState(false);

  // Poll while the invoice is on screen (it's an hour-long invoice; leaving
  // the screen stops the watching, not the invoice).
  useEffect(() => {
    if (!invoice || paid) return;
    let cancelled = false;
    const tick = async () => {
      try {
        if ((await walletApi.invoicePaid(invoice.paymentHash)) && !cancelled) {
          setPaid(true);
          onPaid();
        }
      } catch {
        /* keep watching; a blip isn't a failure */
      }
    };
    const id = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [invoice, paid, onPaid]);

  const create = async () => {
    const n = Number(amount);
    if (!Number.isInteger(n) || n < 1) {
      setError('Enter a whole number of sats');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setInvoice(await walletApi.receive(n, memo.trim() || undefined));
      setPaid(false);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (invoice) {
    const uri = `lightning:${invoice.invoice}`;
    return (
      <section className="mt-4 rounded-xl border border-border bg-card p-4">
        {paid ? (
          <div className="py-6 text-center">
            <Check className="mx-auto mb-2 h-8 w-8 text-primary" />
            <p className="font-medium text-foreground">Received {sats(invoice.amountSats)}</p>
            <Button variant="ghost" className="mt-3" onClick={() => setInvoice(null)}>
              Done
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">
              Pay {sats(invoice.amountSats)} into Collaborator's wallet
            </p>
            <div className="mt-3 flex justify-center">
              <QrCode value={uri} label={`Lightning invoice for ${sats(invoice.amountSats)}`} />
            </div>
            <p className="mt-3 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-snug text-muted-foreground">
              {invoice.invoice}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button onClick={() => (window.location.href = uri)}>
                <Zap className="mr-1.5 h-4 w-4" />
                Open wallet
              </Button>
              <CopyButton text={invoice.invoice} />
            </div>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for payment…
            </p>
            <Button variant="ghost" className="mt-1 w-full" onClick={() => setInvoice(null)}>
              New invoice
            </Button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="mt-4 space-y-3 rounded-xl border border-border bg-card p-4">
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">Amount (sats)</span>
        <input
          className={INPUT}
          inputMode="numeric"
          placeholder="e.g. 5000"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">Note (optional)</span>
        <input
          className={INPUT}
          placeholder="Top up Collaborator's wallet"
          value={memo}
          maxLength={200}
          onChange={(e) => setMemo(e.target.value)}
        />
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" onClick={() => void create()} disabled={busy || !amount}>
        {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        Create invoice
      </Button>
    </section>
  );
}

/** Paste an invoice, see what it asks for, then pay it. */
function SendPanel({ onSent }: { onSent: () => void }) {
  const [text, setText] = useState('');
  const [decoded, setDecoded] = useState<DecodedInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const check = async (value = text) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    setDecoded(null);
    try {
      const d = await walletApi.decode(value);
      if (d.amountSats == null) {
        setError('This invoice has no amount. Ask for one with an amount in it.');
      } else {
        setDecoded(d);
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      setText(clip);
      void check(clip);
    } catch {
      setError('Couldn’t read the clipboard. Paste the invoice into the box.');
    }
  };

  const pay = async () => {
    if (!decoded) return;
    setBusy(true);
    setError(null);
    try {
      const r = await walletApi.send(decoded.invoice);
      if (r.status === 'paid') {
        setResult(
          r.alreadyPaid
            ? 'This invoice was already paid. Nothing was sent again.'
            : `Sent ${sats(r.amountSats)}${r.feesSats ? ` (+${sats(r.feesSats)} fee)` : ''}.`,
        );
      } else {
        setResult(
          'The wallet took the payment but hasn’t confirmed it yet. It may still ' +
            'settle. Sending the same invoice again checks first and never pays twice.',
        );
      }
      setDecoded(null);
      setText('');
      onSent();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-4 space-y-3 rounded-xl border border-border bg-card p-4">
      {result && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">{result}</p>
      )}
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">Lightning invoice</span>
        <textarea
          className={`${INPUT} min-h-[5.5rem] resize-none font-mono text-xs sm:text-xs`}
          placeholder="lnbc…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDecoded(null);
            setResult(null);
          }}
          onBlur={() => void check()}
        />
      </label>
      {!decoded && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => void paste()} disabled={busy}>
            <ClipboardPaste className="mr-1.5 h-4 w-4" />
            Paste
          </Button>
          <Button variant="secondary" onClick={() => void check()} disabled={busy || !text.trim()}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Check
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {decoded && decoded.amountSats != null && (
        <div className="space-y-2">
          <div className="rounded-md bg-muted px-3 py-2">
            <p className="text-lg font-semibold tabular-nums text-foreground">
              {sats(decoded.amountSats)}
            </p>
            {decoded.description && (
              <p className="text-sm text-muted-foreground">{decoded.description}</p>
            )}
            {decoded.expired && (
              <p className="mt-1 text-sm text-destructive">This invoice has expired.</p>
            )}
          </div>
          <Button
            className="w-full"
            onClick={() => void pay()}
            disabled={busy || !!decoded.expired}
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <ArrowUpRight className="mr-1.5 h-4 w-4" />
            )}
            Pay {sats(decoded.amountSats)}
          </Button>
        </div>
      )}
    </section>
  );
}

function RecentSpends({ spends }: { spends: WalletSpend[] }) {
  if (spends.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Recent payments out
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {spends.map((s, i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-2.5">
            <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {s.reason || (s.source === 'user' ? 'Sent by you' : 'Paid by Collaborator')}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.source === 'user' ? 'You' : 'Collaborator'} ·{' '}
                {new Date(s.createdAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {s.status === 'unconfirmed' && (
                  <span className="text-amber-600 dark:text-amber-400"> · unconfirmed</span>
                )}
              </p>
            </div>
            <span className="shrink-0 text-sm tabular-nums text-foreground">
              −{s.amountSats.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
