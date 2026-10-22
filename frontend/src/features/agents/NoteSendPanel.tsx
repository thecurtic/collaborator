import { Loader2, Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { agentsApi, type NoteSendState } from '@/api/agents';
import { Button } from '@/components/ui/button';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Sending a note to its project's agents (agent doc, Sending a note): shown
 * only when the note's project has a channel that accepts input. Nothing
 * goes out until the user presses send, including a send Collaborator's
 * model staged. It goes to the default channel; sending again is an update
 * the backend versions.
 */
export function NoteSendPanel({ title }: { title: string }) {
  const [state, setState] = useState<NoteSendState | null>(null);
  const [busy, setBusy] = useState<'send' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    agentsApi.noteState(title)
      .then((s) => { if (!cancelled) setState(s); })
      .catch(() => { if (!cancelled) setState(null); });   // no agents: nothing to show
    return () => { cancelled = true; };
  }, [title]);

  if (!state || (!state.canSend && !state.staged)) return null;

  const run = async (what: 'send' | 'discard') => {
    setBusy(what);
    setError(null);
    try {
      setState(what === 'send' ? await agentsApi.sendNote(title)
        : await agentsApi.discardStaged(title));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const target = state.target?.label ?? state.staged?.project ?? '';
  return (
    <div className="mb-3 rounded-lg border border-border px-3 py-2">
      {state.staged ? (
        <>
          <p className="text-xs text-foreground">
            Collaborator staged this note to send to <span className="font-medium">{target}</span>.
            Nothing goes out until you send it.
          </p>
          {state.staged.comment && (
            <p className="mt-1 text-xs italic text-muted-foreground">“{state.staged.comment}”</p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {state.lastSent
            ? `Sent ${when(state.lastSent.sentAt)}. Sending again updates it.`
            : `Send this note to ${target}.`}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={!state.canSend || busy !== null} onClick={() => void run('send')}
                className="gap-1.5">
          {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {state.lastSent ? 'Send again' : 'Send'} to {target}
        </Button>
        {state.staged && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run('discard')}
                  className="gap-1.5 text-muted-foreground">
            <X className="h-3.5 w-3.5" /> Discard
          </Button>
        )}
      </div>
      {!state.canSend && state.staged && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          No channel takes input right now; it can be sent once one does.
        </p>
      )}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}
