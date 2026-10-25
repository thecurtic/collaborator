import { Check, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { agentsApi, type AgentEndpoints } from '@/api/agents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TeamRequestsPanel } from './TeamRequestsPanel';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * Settings → Agents (agent doc, Pairing): an endpoint that connects for the
 * first time waits here with a short fingerprint; compare it with what the
 * endpoint prints and approve it once. It's paired to whoever approves it.
 * One paired endpoint can be marked as the PM: labels are never read as
 * roles, so the mark is how Collaborator knows where Start agents, Merge and
 * Withdraw requests go (TeamRequestsPanel sits under it).
 * Hidden when there's nothing to show (no endpoints, or agents off).
 */
export function AgentEndpointsSection({ open }: { open: boolean }) {
  const [eps, setEps] = useState<AgentEndpoints | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    agentsApi.endpoints().then(setEps).catch(() => setEps(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    // A new endpoint shows up while the sheet is open: check again shortly.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [open, load]);

  if (!eps || (eps.paired.length === 0 && eps.pending.length === 0)) return null;

  const act = async (id: string, what: 'approve' | 'remove' | 'pm' | 'unpm') => {
    setBusy(id);
    setError(null);
    try {
      if (what === 'approve') await agentsApi.approve(id);
      else if (what === 'pm') await agentsApi.setPm(id);
      else if (what === 'unpm') await agentsApi.setPm(null);
      else await agentsApi.remove(id);
      load();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-5 space-y-2 border-t border-border pt-4">
      <p className="text-sm font-medium">Agents</p>
      {eps.pending.map((e) => (
        <div key={e.id} className="rounded-md border border-primary/40 bg-primary/5 p-2.5">
          <p className="text-xs text-foreground">
            <span className="font-medium">{e.name}</span> wants to connect.
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{e.fingerprint}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Approve only if this matches what the endpoint shows.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy === e.id} onClick={() => void act(e.id, 'approve')} className="gap-1.5">
              {busy === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Approve
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => void act(e.id, 'remove')}>
              Refuse
            </Button>
          </div>
        </div>
      ))}
      {eps.paired.length > 0 && (
        <ul className="space-y-1.5">
          {eps.paired.map((e) => (
            <li key={e.id} className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className={cn('h-2 w-2 shrink-0 rounded-full',
                e.connected && e.health.state === 'ok' ? 'bg-emerald-500'
                  : e.connected ? 'bg-amber-500' : 'bg-muted-foreground/40')} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-foreground">{e.name}</span>
                <span className="text-muted-foreground">
                  {' '}· {e.connected ? (e.health.state === 'ok' ? 'connected' : e.health.detail || 'degraded')
                    : 'not connected'}
                </span>
              </span>
              {e.pm ? (
                <button type="button" disabled={busy === e.id} onClick={() => void act(e.id, 'unpm')}
                        title="Marked as the PM: team requests go here. Tap to unmark."
                        className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                  PM
                </button>
              ) : (e.capabilities.length > 0 || !eps.paired.some((x) => x.pm)) && (
                <button type="button" disabled={busy === e.id} onClick={() => void act(e.id, 'pm')}
                        title="Mark as the PM: where Start agents, Merge and Withdraw go"
                        className={cn('rounded-full border px-2 py-0.5 text-[10px]',
                          e.capabilities.length ? 'border-amber-500/50 text-amber-700'
                            : 'border-border text-muted-foreground')}>
                  Mark as PM
                </button>
              )}
              <button type="button" aria-label={`Forget ${e.name}`} disabled={busy === e.id}
                      onClick={() => void act(e.id, 'remove')}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {e.pm && <TeamRequestsPanel open={open} canCreate={e.capabilities.includes('create_project')} />}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
