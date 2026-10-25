import { Check, Copy, EyeOff, KeyRound, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  agentsApi,
  FINAL_REQUEST_STATES,
  type SigningKey,
  type TeamRequest,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const KIND_LABEL: Record<TeamRequest['kind'], string> = {
  create_project: 'Start agents',
  merge: 'Merge',
  withdraw: 'Withdraw',
};

/** "4m", "3h", "2d": how long a request has been around. */
export function age(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function StateChip({ state }: { state: TeamRequest['state'] }) {
  return (
    <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
      state === 'done' && 'bg-primary/10 text-primary',
      (state === 'refused' || state === 'failed') && 'bg-destructive/10 text-destructive',
      state === 'withdrawn' && 'bg-muted text-muted-foreground',
      !FINAL_REQUEST_STATES.includes(state) && 'bg-amber-500/10 text-amber-700')}>
      {state}
    </span>
  );
}

/** The signing key: made once here; its public half goes into the keeper's config. */
function KeyBlock({ keyInfo, onChange }: { keyInfo: SigningKey | null; onChange: (k: SigningKey) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const make = async (replace: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await agentsApi.createSigningKey(replace));
      setConfirm(false);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!keyInfo) {
    return (
      <div className="rounded-md border border-border p-2.5 text-xs">
        <p className="text-foreground">
          Requests to the team are signed with a key only Collaborator holds. Make it once,
          then copy its public key and key id into the team's config (pi-session-manager's keeper).
        </p>
        <Button size="sm" className="mt-2 gap-1.5" disabled={busy} onClick={() => void make(false)}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
          Create the signing key
        </Button>
        {error && <p className="mt-1 text-destructive">{error}</p>}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border p-2.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" /> Signing key{' '}
        <span className="font-mono font-normal text-muted-foreground">{keyInfo.keyId}</span>
      </p>
      <p className="mt-1 text-muted-foreground">
        Fingerprint <span className="font-mono text-foreground">{keyInfo.fingerprint}</span>: the
        team logs it at startup; it should match.
      </p>
      <div className="mt-1.5 flex items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px]">
          {keyInfo.publicKey}
        </code>
        <button type="button" aria-label="Copy the public key" title="Copy the public key"
                onClick={() => void navigator.clipboard?.writeText(keyInfo.publicKey).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {confirm ? (
        <div className="mt-2 rounded border border-destructive/40 bg-destructive/5 p-2">
          <p className="text-foreground">
            A new key gets a new key id and the old private key is gone. Add the new public key
            to the team's config before removing the old one, or open requests stop verifying.
          </p>
          <div className="mt-1.5 flex gap-2">
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void make(true)}>
              Replace the key
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirm(true)}
                className="mt-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline">
          Replace the key…
        </button>
      )}
      {error && <p className="mt-1 text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Under the endpoint marked as the PM (Settings → Agents): the signing key
 * and the history of every signed request, for peace of mind. Starting
 * agents lives with the project (a project note, the project's page);
 * merges are the PM's question cards. Open requests can be withdrawn
 * (signed), finished ones hidden here only.
 */
export function TeamRequestsPanel({ open, canCreate }: { open: boolean; canCreate: boolean }) {
  const [keyInfo, setKeyInfo] = useState<SigningKey | null | undefined>(undefined);
  const [requests, setRequests] = useState<TeamRequest[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    agentsApi.requests().then(setRequests).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    agentsApi.signingKey().then(setKeyInfo).catch((err) => setError(errMessage(err)));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [open, load]);

  const act = async (id: string, what: 'withdraw' | 'hide') => {
    setBusy(id);
    setError(null);
    try {
      if (what === 'withdraw') await agentsApi.withdraw(id);
      else await agentsApi.hideRequest(id);
      load();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (keyInfo === undefined) return null;
  const all = requests ?? [];
  const visible = all.filter((r) => showHidden || !r.hidden);
  const hiddenCount = all.filter((r) => r.hidden).length;
  const byId = Object.fromEntries(all.map((r) => [r.id, r]));

  return (
    <div className="ml-4 space-y-2 border-l border-border pl-3">
      <KeyBlock keyInfo={keyInfo} onChange={setKeyInfo} />
      {keyInfo && (
        <p className="text-[11px] text-muted-foreground">
          {canCreate
            ? 'Start agents from a project note or a project\'s page.'
            : 'This PM hasn\'t offered to start projects yet (no create_project in its discovery).'}
        </p>
      )}
      <div>
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs font-medium">Signed requests</p>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowHidden((h) => !h)}
                    className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
              {showHidden ? 'Hide finished' : `Show hidden (${hiddenCount})`}
            </button>
          )}
        </div>
        {visible.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">None yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border rounded-md border border-border">
            {visible.map((r) => {
              const finished = FINAL_REQUEST_STATES.includes(r.state);
              const target = r.target ? byId[r.target] : null;
              return (
                <li key={r.id} className={cn('px-2 py-1.5 text-xs', r.hidden && 'opacity-60')}>
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-foreground">{KIND_LABEL[r.kind]}</span>
                      {r.kind === 'withdraw'
                        ? <span className="text-muted-foreground">
                            {' '}{target ? `${KIND_LABEL[target.kind].toLowerCase()} ${target.project ?? ''}` : r.target}
                          </span>
                        : r.project && <span className="text-muted-foreground"> {r.project}</span>}
                    </span>
                    <StateChip state={r.state} />
                    <span className="w-7 shrink-0 text-right text-[11px] text-muted-foreground">
                      {age(r.createdAt)}
                    </span>
                    {!finished && r.kind !== 'withdraw' && (
                      <button type="button" disabled={busy === r.id} onClick={() => void act(r.id, 'withdraw')}
                              title="Withdraw (signed): it stops if the work hasn't started"
                              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                        {busy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Withdraw'}
                      </button>
                    )}
                    {finished && !r.hidden && (
                      <button type="button" aria-label="Hide from the list" title="Hide from the list"
                              disabled={busy === r.id} onClick={() => void act(r.id, 'hide')}
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <EyeOff className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {(r.text || r.step) && (
                    <p className={cn('mt-0.5 text-[11px]',
                      r.state === 'refused' || r.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                      {[r.step, r.text].filter(Boolean).join(': ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {error && (
        <p className="flex items-center gap-1 text-xs text-destructive">
          {error}
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}><X className="h-3 w-3" /></button>
        </p>
      )}
    </div>
  );
}
