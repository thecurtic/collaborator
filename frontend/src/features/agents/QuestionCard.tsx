import { Check, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { agentsApi, type AgentMessage, type AgentQuestion } from '@/api/agents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * A question from an agent channel, the same wherever it shows up (its
 * channel, its Feed card): options as buttons (checkboxes when several can
 * be picked), free text when the harness allows it. Once answered or
 * closed, it shows the outcome instead of live controls.
 */
export function QuestionCard({
  messageId,
  question,
  state,
  outcome,
  onAnswered,
  compact = false,
}: {
  messageId: number;
  question: AgentQuestion;
  state: AgentMessage['questionState'];
  outcome: AgentMessage['outcome'];
  onAnswered?: (m: AgentMessage) => void;
  /** Feed card: no header chip, tighter spacing. */
  compact?: boolean;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState(question.prefill ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = state === 'open';

  const submit = async (optionIds: string[], words: string) => {
    setBusy(true);
    setError(null);
    try {
      onAnswered?.(await agentsApi.answer(messageId, optionIds, words));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    const labels = Object.fromEntries(question.options.map((o) => [o.id, o.label]));
    const chosen = (outcome?.option_ids ?? []).map((id) => labels[id] ?? id);
    const answer = [chosen.join(', '), outcome?.text].filter(Boolean).join(' · ');
    return (
      <div className={cn('rounded-lg border border-border bg-muted/40', compact ? 'p-2' : 'p-3')}>
        <p className="text-sm text-foreground">{question.prompt}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5" />
          {answer || (outcome?.reason ? outcome.reason : 'Closed')}
          {answer && outcome?.reason && outcome.reason !== 'answered' && ` (${outcome.reason})`}
        </p>
      </div>
    );
  }

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className={cn('rounded-lg border border-primary/40 bg-primary/5', compact ? 'p-2' : 'p-3')}>
      {question.header && !compact && (
        <span className="mb-1 inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
          {question.header}
        </span>
      )}
      <p className="whitespace-pre-wrap text-sm text-foreground">{question.prompt}</p>
      {question.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {question.options.map((o) =>
            question.multiple ? (
              <button key={o.id} type="button" disabled={busy} onClick={() => toggle(o.id)}
                      aria-pressed={picked.includes(o.id)} title={o.description}
                      className={cn('rounded-md border px-2.5 py-1.5 text-left text-sm',
                        picked.includes(o.id) ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-background text-foreground hover:bg-muted')}>
                {o.label}
                {o.description && <span className="block text-[11px] text-muted-foreground">{o.description}</span>}
              </button>
            ) : (
              <button key={o.id} type="button" disabled={busy}
                      onClick={() => void submit([o.id], question.freeform ? text : '')}
                      title={o.description}
                      className="rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-muted active:bg-muted">
                {o.label}
                {o.description && <span className="block text-[11px] text-muted-foreground">{o.description}</span>}
              </button>
            ),
          )}
        </div>
      )}
      {(question.freeform || question.multiple) && (
        <div className="mt-2 flex items-end gap-2">
          {question.freeform && (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1}
                      placeholder={question.placeholder ?? (question.options.length ? 'Or write an answer' : 'Your answer')}
                      className="min-h-9 flex-1 resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary" />
          )}
          <Button size="sm" disabled={busy || (!picked.length && !text.trim())}
                  onClick={() => void submit(picked, question.freeform ? text : '')}
                  className={cn(!question.freeform && 'ml-auto')}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Answer'}
          </Button>
        </div>
      )}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}
