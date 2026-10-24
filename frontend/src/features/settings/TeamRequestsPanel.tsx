import { Check, Copy, EyeOff, FileText, KeyRound, Loader2, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import {
  agentsApi,
  FINAL_REQUEST_STATES,
  type SigningKey,
  type TeamRequest,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { NoteMeta } from '@/domain/models';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

const KIND_LABEL: Record<TeamRequest['kind'], string> = {
  create_project: 'New project',
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
          then copy its public key and key id into the keeper's config.
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
        keeper logs it at startup; it should match.
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
            to the keeper before removing the old one, or open requests stop verifying.
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

/** Pick a note whose body becomes the intents. */
function NotePicker({ onPick }: { onPick: (body: string, title: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<NoteMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api.searchNotes(q.trim(), 'keyword', 6).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="rounded border border-border p-1.5">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a note"
             aria-label="Find a note for the intents"
             className="w-full bg-transparent px-1 py-0.5 text-base outline-none sm:text-xs" />
      {hits.map((n) => (
        <button key={n.title} type="button"
                onClick={() => {
                  setError(null);
                  api.getNote(n.title).then((note) => onPick(note.body, note.title))
                    .catch((err) => setError(errMessage(err)));
                }}
                className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs hover:bg-muted">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{n.title}</span>
        </button>
      ))}
      {error && <p className="px-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-base outline-none focus:border-primary sm:text-xs';

/** New project: the PM's manager writes the request; the keeper makes the repo. */
function NewProjectForm({ onDone, onCancel }: { onDone: (r: TeamRequest) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [roles, setRoles] = useState('');
  const [intents, setIntents] = useState('');
  const [fromNote, setFromNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [kickoff, setKickoff] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = NAME_RE.test(name);
  const ready = nameOk && description.trim() && intents.trim();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await agentsApi.createProject({
        name, description,
        roles: roles.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean),
        intentsMd: intents, kickoff,
      }));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-2.5 text-xs">
      <p className="font-medium text-foreground">New project</p>
      <label className="block space-y-0.5">
        <span className="text-muted-foreground">Name (also the project tag)</span>
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())}
               placeholder="tidepool" className={cn(field, 'font-mono')} autoCapitalize="none" />
        {name && !nameOk && (
          <span className="block text-[11px] text-destructive">
            2–39 characters: lowercase letters, digits and hyphens, not starting with a hyphen.
          </span>
        )}
      </label>
      <label className="block space-y-0.5">
        <span className="text-muted-foreground">One-line description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
      </label>
      <label className="block space-y-0.5">
        <span className="text-muted-foreground">Roles (optional; empty = the team's usual ones)</span>
        <input value={roles} onChange={(e) => setRoles(e.target.value.toLowerCase())}
               placeholder="pm, backend, auditor" className={field} autoCapitalize="none" />
      </label>
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-muted-foreground">
            Intents{fromNote ? <> (from “{fromNote}”)</> : null}
          </span>
          <button type="button" onClick={() => setPicking((p) => !p)}
                  className="text-[11px] text-primary underline-offset-2 hover:underline">
            {picking ? 'Type them' : 'Use a note'}
          </button>
        </div>
        {picking && (
          <NotePicker onPick={(body, title) => {
            setIntents(body);
            setFromNote(title);
            setPicking(false);
          }} />
        )}
        <textarea value={intents} onChange={(e) => { setIntents(e.target.value); setFromNote(null); }}
                  rows={5} placeholder="# What it's for…" className={cn(field, 'resize-y font-mono')} />
      </div>
      <label className="block space-y-0.5">
        <span className="text-muted-foreground">Kickoff for the PM (optional)</span>
        <textarea value={kickoff} onChange={(e) => setKickoff(e.target.value)} rows={2}
                  className={cn(field, 'resize-y')} />
      </label>
      <p className="text-[11px] text-muted-foreground">
        The repo starts from the AGENTS.md template; the PM tailors it from the intents. Creating
        a repo has no undo, but you can withdraw the request until the project starts.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !ready} onClick={() => void submit()} className="gap-1.5">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Under the endpoint marked as the PM (Settings → Agents): the signing key,
 * New project, and every request with its state. Requests never expire;
 * open ones can be withdrawn (signed), finished ones hidden here only.
 */
export function TeamRequestsPanel({ open, canCreate }: { open: boolean; canCreate: boolean }) {
  const [keyInfo, setKeyInfo] = useState<SigningKey | null | undefined>(undefined);
  const [requests, setRequests] = useState<TeamRequest[] | null>(null);
  const [showForm, setShowForm] = useState(false);
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
      {keyInfo && canCreate && (showForm ? (
        <NewProjectForm onCancel={() => setShowForm(false)} onDone={() => {
          setShowForm(false);
          load();
        }} />
      ) : (
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowForm(true)}>
          <Plus className="h-3.5 w-3.5" /> New project
        </Button>
      ))}
      {keyInfo && !canCreate && (
        <p className="text-[11px] text-muted-foreground">
          This endpoint hasn't offered project requests (no create_project in its discovery).
        </p>
      )}
      <div>
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs font-medium">Requests</p>
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
                              title="Withdraw (signed): the keeper stops it if it hasn't started"
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
