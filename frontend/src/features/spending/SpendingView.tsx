import { Check, ChevronDown, ChevronRight, Loader2, Pencil, Plus, Receipt, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLive } from '@/lib/live';
import {
  CHARGE_KINDS,
  PAYMENT_METHODS,
  spendingApi,
  type LineLabel,
  type SpendingCategory,
  type SpendingDetail,
  type SpendingLine,
  type SpendingProduct,
  type SpendingPeriod,
  type SpendingTotal,
  type SpendingTransaction,
  type UnsureLine,
} from './spendingApi';
import {
  draftChanged,
  formatDay,
  formatMoney,
  fromDraft,
  toDraft,
  type ReceiptDraft,
} from './spendingFormat';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

// No width here: row fields size themselves (w-12, flex-1 …); a lone field
// takes FIELD. A w-full in the base would beat those and push rows off-screen.
const INPUT =
  'min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-base text-foreground ' +
  'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring sm:text-sm';
const FIELD = `${INPUT} w-full`;

const PERIODS: { key: SpendingPeriod; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
];

/**
 * Spending (receipt-capture spec): receipts held in Scratch land here.
 * Pending ones are pinned on top until approved (corrected first if need
 * be) or discarded; below, the period total and every committed purchase.
 * Open to change once it's been lived with (spec).
 */
export function SpendingView() {
  const [pending, setPending] = useState<SpendingTransaction[] | null>(null);
  const [committed, setCommitted] = useState<SpendingTransaction[]>([]);
  const [period, setPeriod] = useState<SpendingPeriod>('month');
  const [total, setTotal] = useState<SpendingTotal | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [unsure, setUnsure] = useState<UnsureLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, c, t, u] = await Promise.all([
        spendingApi.list('pending'),
        spendingApi.list('committed'),
        spendingApi.total(period),
        spendingApi.unsureLabels(),
      ]);
      setUnsure(u);
      setPending(p);
      setCommitted(c);
      setTotal(t);
      setError(null);
    } catch (err) {
      setError(errMessage(err));
    }
  }, [period]);
  useLive(['spending'], () => void refresh());

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = (id: number) => setOpen((cur) => (cur === id ? null : id));
  const decided = () => {
    setOpen(null);
    void refresh();
  };

  if (pending === null && !error) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading spending…
      </div>
    );
  }

  const empty = (pending?.length ?? 0) === 0 && committed.length === 0;

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-4 py-4">
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        {empty && (
          <div className="py-8 text-center text-muted-foreground">
            <Receipt className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p className="text-lg font-medium text-foreground">No receipts yet</p>
            <p className="mt-1 px-8 text-sm">
              Photograph a receipt in Scratch and hold send. It shows up here
              to check before it counts.
            </p>
          </div>
        )}

        {pending && pending.length > 0 && (
          <section className="mb-6">
            <h3 className="mb-2 text-sm font-medium text-foreground">
              To check ({pending.length})
            </h3>
            <ul className="space-y-2">
              {pending.map((tx) => (
                <li key={tx.id} className="rounded-xl border border-primary/40 bg-card">
                  <TxRow tx={tx} open={open === tx.id} onToggle={() => toggle(tx.id)} />
                  {open === tx.id && (
                    <PendingEditor id={tx.id} onDone={decided} onError={setError} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {unsure.length > 0 && <CheckLabels lines={unsure} onChanged={() => void refresh()} />}

        {!empty && (
          <section className="mb-6 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {total ? `Since ${formatDay(total.since)}` : 'Spent'}
              </p>
              <div className="flex rounded-md border border-border p-0.5" role="tablist">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="tab"
                    aria-selected={period === p.key}
                    onClick={() => setPeriod(p.key)}
                    className={`rounded px-2.5 py-1 text-xs ${
                      period === p.key
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            {total && total.totals.length > 0 ? (
              total.totals.map((t) => (
                <p key={t.currency ?? '-'} className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
                  {formatMoney(t.totalCents, t.currency)}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {t.count} purchase{t.count === 1 ? '' : 's'}
                  </span>
                </p>
              ))
            ) : (
              <p className="mt-1 text-3xl font-semibold tabular-nums text-muted-foreground">
                {formatMoney(0)}
              </p>
            )}
          </section>
        )}

        {committed.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium text-foreground">Purchases</h3>
            <ul className="divide-y divide-border rounded-xl border border-border bg-card">
              {committed.map((tx) => (
                <li key={tx.id}>
                  <TxRow tx={tx} open={open === tx.id} onToggle={() => toggle(tx.id)} />
                  {open === tx.id && (
                    <CommittedDetail id={tx.id} onError={setError} onDeleted={decided} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * Labels the models weren't sure of. Optional: they already count; fixing
 * one fixes every line the store printed the same way.
 */
function CheckLabels({ lines, onChanged }: { lines: UnsureLine[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  return (
    <section className="mb-6">
      <button type="button" onClick={() => setShown((v) => !v)}
              className="mb-2 flex items-center gap-1 text-sm font-medium text-foreground">
        {shown ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Check these labels ({lines.length})
      </button>
      {shown && (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {lines.map((l) => (
            <li key={l.id} className="px-3 py-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="min-w-0 truncate text-foreground">{l.rawText}</span>
                <span className="flex-none tabular-nums text-muted-foreground">
                  {formatMoney(l.lineTotalCents)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {[l.store, formatDay(l.datetime)].filter(Boolean).join(' · ')}
              </p>
              <button type="button"
                      className="text-left text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setEditing((cur) => (cur === l.id ? null : l.id))}>
                <LabelText line={{ match: 'unsure', product: l.product }} />
              </button>
              {editing === l.id && (
                <LabelEditor lineId={l.id} onCancel={() => setEditing(null)}
                             onDone={() => { setEditing(null); onChanged(); }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TxRow({
  tx,
  open,
  onToggle,
}: {
  tx: SpendingTransaction;
  open: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {tx.store || 'Unknown store'}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatDay(tx.datetime) || 'No date'}
        </p>
        {tx.status === 'pending' && tx.review.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tx.review.map((r) => (
              <span key={r} className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                {r}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
        {formatMoney(tx.amountCents, tx.currency)}
      </span>
      <Chevron className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The receipt image (authenticated fetch; tap to see it full size). */
function EvidenceImage({ id }: { id: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [big, setBig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    spendingApi
      .evidenceImage(id)
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);

  if (failed) return <p className="text-xs text-muted-foreground">(image unavailable)</p>;
  if (!url)
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> loading image…
      </p>
    );
  return (
    <button type="button" onClick={() => setBig((b) => !b)} aria-label="Toggle image size">
      <img
        src={url}
        alt="receipt"
        className={`rounded-lg border border-border object-contain ${big ? 'w-full' : 'max-h-48'}`}
      />
    </button>
  );
}

function useDetail(id: number, onError: (e: string) => void, version = 0) {
  const [tx, setTx] = useState<SpendingDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    spendingApi
      .get(id)
      .then((t) => !cancelled && setTx(t))
      .catch((err) => !cancelled && onError(errMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [id, onError, version]);
  return tx;
}

function Evidence({ tx }: { tx: SpendingDetail }) {
  return (
    <>
      {tx.evidence.map((e) => (
        <div key={e.id} className="space-y-1">
          <EvidenceImage id={e.id} />
          {e.caption && <p className="text-sm text-foreground">“{e.caption}”</p>}
          {e.unmapped.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Also on the receipt: {e.unmapped.join(' · ')}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

/** What a line is labelled as, or that it isn't yet. */
function LabelText({ line }: { line: Pick<SpendingLine, 'match' | 'product'> }) {
  if (!line.product) return <span className="italic">not labelled yet</span>;
  const p = line.product;
  return (
    <>
      {[p.name, p.brand, p.category].filter(Boolean).join(' · ')}
      {line.match === 'unsure' && (
        <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[11px] text-amber-700 dark:text-amber-400">
          unsure
        </span>
      )}
    </>
  );
}

/**
 * Relabel a line: pick an existing product, or describe a new one. Every
 * line the store printed the same way follows, and it's remembered.
 */
function LabelEditor({
  lineId,
  onDone,
  onCancel,
}: {
  lineId: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<SpendingProduct[]>([]);
  const [cats, setCats] = useState<SpendingCategory[]>([]);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      spendingApi
        .searchProducts(q)
        .then((r) => !cancelled && setFound(r))
        .catch((err) => !cancelled && setProblem(errMessage(err)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    if (!making || cats.length) return;
    spendingApi.categories().then(setCats).catch((err) => setProblem(errMessage(err)));
  }, [making, cats.length]);

  const save = async (label: LineLabel) => {
    setBusy(true);
    setProblem(null);
    try {
      await spendingApi.correctLine(lineId, label);
      onDone();
    } catch (err) {
      setProblem(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 space-y-2 rounded-lg border border-border bg-background p-2">
      {!making ? (
        <>
          <input className={FIELD} value={q} placeholder="Find a product"
                 onChange={(e) => setQ(e.target.value)} autoFocus />
          <ul className="max-h-48 overflow-y-auto">
            {found.map((p) => (
              <li key={p.id}>
                <button type="button" disabled={busy}
                        className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() => void save({ productId: p.id })}>
                  {p.name}
                  <span className="text-muted-foreground">
                    {[p.brand, p.category].filter(Boolean).map((x) => ` · ${x}`).join('')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => { setMaking(true); setName(q); }}>
              <Plus className="mr-1 h-3.5 w-3.5" /> New product
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <input className={FIELD} value={name} placeholder="What it is (e.g. coffee beans)"
                 onChange={(e) => setName(e.target.value)} autoFocus />
          <input className={FIELD} value={brand} placeholder="Brand (optional)"
                 onChange={(e) => setBrand(e.target.value)} />
          <input className={FIELD} value={category} placeholder="Category" list={`cats-${lineId}`}
                 onChange={(e) => setCategory(e.target.value)} />
          <datalist id={`cats-${lineId}`}>
            {cats.map((c) => <option key={c.id} value={c.name} />)}
          </datalist>
          <div className="flex justify-between gap-2">
            <Button size="sm" disabled={busy || !name.trim()}
                    onClick={() => void save({ new: {
                      name: name.trim(), brand: brand.trim() || null,
                      category: category.trim() || null,
                    } })}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMaking(false)}>Back</Button>
          </div>
        </>
      )}
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}

/** A committed purchase: the image, its lines (each with its product label,
 * correctable), charges, payment. */
function CommittedDetail({
  id,
  onError,
  onDeleted,
}: {
  id: number;
  onError: (e: string) => void;
  onDeleted: () => void;
}) {
  const [version, setVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  useLive(['spending'], () => setVersion((v) => v + 1));
  const tx = useDetail(id, onError, version);
  const [editing, setEditing] = useState<number | null>(null);

  // Two taps: a purchase and its receipt image go for good.
  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await spendingApi.discard(id);
      onDeleted();
    } catch (err) {
      onError(errMessage(err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };
  if (!tx) return <Loader2 className="mx-3 mb-3 h-4 w-4 animate-spin text-muted-foreground" />;
  if (correcting) {
    return (
      <PendingEditor
        id={id}
        onError={onError}
        onCancel={() => setCorrecting(false)}
        onDone={() => {
          setCorrecting(false);
          setVersion((v) => v + 1);
        }}
      />
    );
  }
  const money = (c: number) => formatMoney(c, tx.currency);
  return (
    <div className="space-y-3 border-t border-border px-3 py-3">
      <Evidence tx={tx} />
      <table className="w-full text-sm">
        <tbody>
          {tx.lineItems.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="py-0.5 pr-2 text-foreground">
                {l.qty != null && l.qty !== 1 ? `${l.qty} × ` : ''}
                {l.rawText}
                <button type="button"
                        className="block text-left text-xs text-muted-foreground hover:text-foreground"
                        aria-label={`Relabel ${l.rawText}`}
                        onClick={() => setEditing((cur) => (cur === l.id ? null : l.id))}>
                  <LabelText line={l} />
                </button>
                {editing === l.id && (
                  <LabelEditor lineId={l.id} onCancel={() => setEditing(null)}
                               onDone={() => { setEditing(null); setVersion((v) => v + 1); }} />
                )}
              </td>
              <td className="py-0.5 text-right tabular-nums">{money(l.lineTotalCents)}</td>
            </tr>
          ))}
          {tx.subtotalCents != null && (
            <tr className="border-t border-border">
              <td className="py-0.5 pr-2 text-muted-foreground">Subtotal</td>
              <td className="py-0.5 text-right tabular-nums">{money(tx.subtotalCents)}</td>
            </tr>
          )}
          {tx.charges.map((c, i) => (
            <tr key={`c${i}`}>
              <td className="py-0.5 pr-2 text-muted-foreground">{c.name || c.kind}</td>
              <td className="py-0.5 text-right tabular-nums">{money(c.amountCents)}</td>
            </tr>
          ))}
          <tr className="border-t border-border font-medium">
            <td className="py-0.5 pr-2">Total</td>
            <td className="py-0.5 text-right tabular-nums">{money(tx.amountCents)}</td>
          </tr>
        </tbody>
      </table>
      {tx.payment && (
        <p className="text-xs text-muted-foreground">
          Paid by {tx.payment.method}
          {tx.payment.cardBrand ? ` · ${tx.payment.cardBrand}` : ''}
          {tx.payment.lastFour ? ` ···${tx.payment.lastFour}` : ''}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {!confirmDelete && (
          <Button variant="ghost" size="sm" className="text-muted-foreground"
                  onClick={() => setCorrecting(true)}>
            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
          </Button>
        )}
        {confirmDelete && !deleting && (
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
            Keep it
          </Button>
        )}
        <Button
          variant={confirmDelete ? 'destructive' : 'ghost'}
          size="sm"
          disabled={deleting}
          onClick={() => void remove()}
          className={confirmDelete ? '' : 'text-muted-foreground'}
        >
          {deleting ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="mr-1 h-3.5 w-3.5" />
          )}
          {confirmDelete ? 'Delete purchase and receipt?' : 'Delete'}
        </Button>
      </div>
    </div>
  );
}

/** A pending receipt: every field editable, then approve or discard. */
function PendingEditor({
  id,
  onDone,
  onError,
  onCancel,
}: {
  id: number;
  onDone: () => void;
  onError: (e: string) => void;
  /** Given: correcting an approved purchase (Save / Cancel, no approve). */
  onCancel?: () => void;
}) {
  const editing = onCancel !== undefined;
  const tx = useDetail(id, onError);
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [busy, setBusy] = useState<'approve' | 'discard' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (tx) setDraft(toDraft(tx));
  }, [tx]);

  if (!tx || !draft)
    return <Loader2 className="mx-3 mb-3 h-4 w-4 animate-spin text-muted-foreground" />;

  const set = (patch: Partial<ReceiptDraft>) => setDraft({ ...draft, ...patch });
  const setLine = (i: number, patch: Partial<ReceiptDraft['lines'][number]>) =>
    set({ lines: draft.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const setCharge = (i: number, patch: Partial<ReceiptDraft['charges'][number]>) =>
    set({ charges: draft.charges.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  // Removing a row blanks it (indices stay put, so charges keep their line);
  // a blanked row that was read from the receipt is hidden.
  const removedLine = (i: number) => {
    const l = draft.lines[i];
    return i < tx.lineItems.length && !l.rawText && !l.qty && !l.lineTotal;
  };
  const removedCharge = (i: number) => {
    const c = draft.charges[i];
    return i < tx.charges.length && !c.name && !c.amount;
  };

  const approve = async () => {
    setProblem(null);
    let edit;
    if (draftChanged(draft, toDraft(tx))) {
      const out = fromDraft(draft, tx, tx.evidence.flatMap((e) => e.unmapped));
      if ('error' in out) {
        setProblem(out.error);
        return;
      }
      edit = out.receipt;
    }
    if (editing && !edit) {
      onDone();                 // nothing changed
      return;
    }
    setBusy('approve');
    try {
      if (editing && edit) await spendingApi.update(id, edit);
      else await spendingApi.approve(id, edit);
      onDone();
    } catch (err) {
      setProblem(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy('discard');
    try {
      await spendingApi.discard(id);
      onDone();
    } catch (err) {
      setProblem(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const label = 'mb-1 block text-xs text-muted-foreground';

  return (
    <div className="space-y-4 border-t border-border px-3 py-3">
      <Evidence tx={tx} />

      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2">
          <span className={label}>Store</span>
          <input className={FIELD} value={draft.storeName}
                 onChange={(e) => set({ storeName: e.target.value })} />
        </label>
        <label className="col-span-2">
          <span className={label}>Address</span>
          <input className={FIELD} value={draft.storeAddress}
                 onChange={(e) => set({ storeAddress: e.target.value })} />
        </label>
        <label>
          <span className={label}>Date</span>
          <input className={FIELD} value={draft.date} placeholder="YYYY-MM-DD"
                 onChange={(e) => set({ date: e.target.value })} />
        </label>
        <label>
          <span className={label}>Currency</span>
          <input className={FIELD} value={draft.currency} placeholder="CAD"
                 onChange={(e) => set({ currency: e.target.value })} />
        </label>
      </div>

      <div>
        <span className={label}>Lines (as printed · qty · amount)</span>
        <div className="space-y-1.5">
          {draft.lines.map((l, i) => removedLine(i) ? null : (
            <div key={i} className="flex gap-1.5">
              <input className={`${INPUT} flex-1`} value={l.rawText} aria-label={`Line ${i + 1}`}
                     onChange={(e) => setLine(i, { rawText: e.target.value })} />
              <input className={`${INPUT} w-12 flex-none`} value={l.qty} inputMode="decimal"
                     aria-label={`Line ${i + 1} quantity`}
                     onChange={(e) => setLine(i, { qty: e.target.value })} />
              <input className={`${INPUT} w-20 flex-none text-right`} value={l.lineTotal}
                     inputMode="decimal" aria-label={`Line ${i + 1} amount`}
                     onChange={(e) => setLine(i, { lineTotal: e.target.value })} />
              <Button variant="ghost" size="icon" className="h-9 w-9 flex-none"
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => setLine(i, { rawText: '', qty: '', lineTotal: '' })}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-1"
                onClick={() => set({ lines: [...draft.lines, { rawText: '', qty: '', lineTotal: '' }] })}>
          <Plus className="mr-1 h-4 w-4" /> Line
        </Button>
      </div>

      <div>
        <span className={label}>Taxes, fees, deposits, discounts</span>
        <div className="space-y-1.5">
          {draft.charges.map((c, i) => removedCharge(i) ? null : (
            <div key={i} className="flex gap-1.5">
              <select className={`${INPUT} w-24 flex-none`} value={c.kind}
                      aria-label={`Charge ${i + 1} kind`}
                      onChange={(e) => setCharge(i, { kind: e.target.value as typeof c.kind })}>
                {CHARGE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input className={`${INPUT} flex-1`} value={c.name} aria-label={`Charge ${i + 1} name`}
                     onChange={(e) => setCharge(i, { name: e.target.value })} />
              <input className={`${INPUT} w-20 flex-none text-right`} value={c.amount}
                     inputMode="decimal" aria-label={`Charge ${i + 1} amount`}
                     onChange={(e) => setCharge(i, { amount: e.target.value })} />
              <Button variant="ghost" size="icon" className="h-9 w-9 flex-none"
                      aria-label={`Remove charge ${i + 1}`}
                      onClick={() => setCharge(i, { name: '', amount: '' })}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mt-1"
                onClick={() => set({ charges: [...draft.charges,
                  { kind: 'tax', name: '', amount: '', lineIndex: null }] })}>
          <Plus className="mr-1 h-4 w-4" /> Charge
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className={label}>Subtotal</span>
          <input className={`${FIELD} text-right`} value={draft.subtotal} inputMode="decimal"
                 onChange={(e) => set({ subtotal: e.target.value })} />
        </label>
        <label>
          <span className={label}>Total</span>
          <input className={`${FIELD} text-right font-medium`} value={draft.total} inputMode="decimal"
                 onChange={(e) => set({ total: e.target.value })} />
        </label>
        <label>
          <span className={label}>Paid by</span>
          <select className={FIELD} value={draft.method}
                  onChange={(e) => set({ method: e.target.value as ReceiptDraft['method'] })}>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {draft.method === 'card' && (
          <div className="flex gap-1.5">
            <label className="flex-1">
              <span className={label}>Card</span>
              <input className={FIELD} value={draft.cardBrand}
                     onChange={(e) => set({ cardBrand: e.target.value })} />
            </label>
            <label className="w-16 flex-none">
              <span className={label}>Last 4</span>
              <input className={FIELD} value={draft.lastFour} inputMode="numeric" maxLength={4}
                     onChange={(e) => set({ lastFour: e.target.value.replace(/\D/g, '') })} />
            </label>
          </div>
        )}
      </div>

      {problem && <p className="text-sm text-destructive">{problem}</p>}

      {editing && (
        <p className="text-xs text-muted-foreground">
          Lines you leave as printed keep their labels; a line you change is labelled again.
        </p>
      )}
      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => void approve()} disabled={busy !== null}>
          {busy === 'approve' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            : <Check className="mr-1.5 h-4 w-4" />}
          {editing ? 'Save' : 'Approve'}
        </Button>
        {editing ? (
          <Button variant="secondary" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => void discard()} disabled={busy !== null}>
            {busy === 'discard' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Trash2 className="mr-1.5 h-4 w-4" />}
            Discard
          </Button>
        )}
      </div>
    </div>
  );
}
