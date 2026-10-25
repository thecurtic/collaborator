import { Bot, ChevronRight, GitMerge, Loader2, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  agentsApi,
  connectAgentsLive,
  FINAL_REQUEST_STATES,
  type ProjectTeam,
  type TeamRequest,
} from '@/api/agents';
import { Linked } from '@/components/Linked';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { QuestionCard } from './QuestionCard';
import { StartAgentsSheet } from './StartAgentsSheet';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const START_LABEL: Record<TeamRequest['state'], string> = {
  sending: 'sending to the PM', accepted: 'accepted', progress: 'setting up', waiting: 'waiting',
  done: 'started', refused: 'refused', failed: 'failed', withdrawn: 'withdrawn',
};

/** Why agents can't be started from here, said once and quietly. */
const NOT_YET: Record<Exclude<ProjectTeam['start'], 'ok' | 'no_endpoints'>, string> = {
  no_pm: 'mark your PM in Settings → Agents first',
  no_capability: "your PM hasn't offered to start projects yet",
  no_key: 'create the signing key in Settings → Agents first',
};

export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A project's team, kept current from the live socket (requests, discovery, questions). */
export function useProjectTeam(tag: string | null) {
  const [team, setTeam] = useState<ProjectTeam | null>(null);
  const load = useCallback(() => {
    if (!tag) {
      setTeam(null);
      return;
    }
    agentsApi.team(tag).then(setTeam).catch(() => setTeam(null));   // agents off: nothing
  }, [tag]);

  useEffect(() => {
    load();
    if (!tag) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; load(); }, 600);
    };
    const stop = connectAgentsLive((e) => {
      if (['request', 'discovery', 'message', 'endpoint', 'event'].includes(e.type)) soon();
    }, soon);
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [tag, load]);
  return { team, reload: load };
}

/** "Starting agents on reef: setting up" with Withdraw while it can be. */
function StartStatus({ r, tag, onChange }: { r: TeamRequest; tag: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = !FINAL_REQUEST_STATES.includes(r.state);
  const bad = r.state === 'refused' || r.state === 'failed';
  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await agentsApi.withdraw(r.id);
      onChange();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        {open && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
        <p className={cn('min-w-0 flex-1', bad ? 'text-destructive' : 'text-foreground')}>
          {open ? 'Starting agents on ' : 'Agents on '}
          <span className="font-mono">{tag}</span>: {START_LABEL[r.state]}
          {(r.step || r.text) && (
            <span className="text-muted-foreground"> · {[r.step, r.text].filter(Boolean).join(': ')}</span>
          )}
        </p>
        {open && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void withdraw()}
                  className="h-7 px-2 text-xs text-muted-foreground">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Withdraw'}
          </Button>
        )}
      </div>
      {error && <p className="mt-1 text-destructive">{error}</p>}
    </div>
  );
}

/** Starting is possible (or worth a quiet word about why not). */
function StartRow({ team, tag, onStart }: { team: ProjectTeam; tag: string; onStart: () => void }) {
  if (team.start === 'ok') {
    return (
      <Button size="sm" variant="outline" onClick={onStart} className="gap-1.5">
        <Play className="h-3.5 w-3.5" /> Start agents on <span className="font-mono">{tag}</span>
      </Button>
    );
  }
  if (team.start === 'no_endpoints') return null;
  return (
    <p className="text-xs text-muted-foreground">
      To start agents on <span className="font-mono">{tag}</span>, {NOT_YET[team.start]}.
    </p>
  );
}

/**
 * On a project note (tagged `project`, its project named by the same
 * inference the Projects view uses): start agents on that project from this
 * note, follow the start, or jump to the agents once they're there.
 */
export function NoteTeamPanel({ note, tag, onOpenProject }: {
  note: { title: string; body: string };
  tag: string;
  onOpenProject: (tag: string) => void;
}) {
  const { team, reload } = useProjectTeam(tag);
  const [sheet, setSheet] = useState(false);
  if (!team) return null;
  const r = team.startRequest;
  const inFlight = r && !FINAL_REQUEST_STATES.includes(r.state);
  const fromHere = r?.noteTitle === note.title && r.state !== 'withdrawn';
  // A failed or refused start stays visible until agents arrive or another try.
  const showStatus = r && (inFlight || ((r.state === 'refused' || r.state === 'failed') && !team.served));
  if (!team.served && !showStatus && team.start === 'no_endpoints') return null;

  return (
    <div className="mb-3 space-y-2 rounded-lg border border-border px-3 py-2">
      {team.served ? (
        <button type="button" onClick={() => onOpenProject(tag)}
                className="flex w-full items-center gap-2 text-left text-xs">
          <Bot className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="min-w-0 flex-1 text-foreground">
            Agents on <span className="font-mono">{tag}</span>
            {fromHere && r && (
              <span className="text-muted-foreground"> · started from this note on {shortDate(r.createdAt)}</span>
            )}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      ) : showStatus && r ? (
        <StartStatus r={r} tag={tag} onChange={reload} />
      ) : null}
      {!team.served && !inFlight && (
        <StartRow team={team} tag={tag} onStart={() => setSheet(true)} />
      )}
      <StartAgentsSheet open={sheet} tag={tag} note={note} onClose={() => setSheet(false)}
                        onStarted={() => { setSheet(false); reload(); }} />
    </div>
  );
}

/**
 * The project view's team strip: what's waiting on me (merge and test cards
 * first, answerable here), the last merge and cost so far; or the start in
 * flight; or a way to start agents on this project.
 */
export function TeamStrip({ tag, noteTitles, onOpenAgents }: {
  tag: string;
  /** The project's notes, offered for the intents. */
  noteTitles: string[];
  onOpenAgents: () => void;
}) {
  const { team, reload } = useProjectTeam(tag);
  const [sheet, setSheet] = useState(false);
  const [all, setAll] = useState(false);
  if (!team) return null;
  const r = team.startRequest;
  const inFlight = r && !FINAL_REQUEST_STATES.includes(r.state);
  const failed = r && (r.state === 'refused' || r.state === 'failed') && !team.served;

  if (!team.served) {
    if (!inFlight && !failed && team.start === 'no_endpoints') return null;
    return (
      <div className="space-y-2 border-b border-border px-4 py-3">
        {(inFlight || failed) && r && <StartStatus r={r} tag={tag} onChange={reload} />}
        {!inFlight && <StartRow team={team} tag={tag} onStart={() => setSheet(true)} />}
        <StartAgentsSheet open={sheet} tag={tag} suggestions={noteTitles}
                          onClose={() => setSheet(false)}
                          onStarted={() => { setSheet(false); reload(); }} />
      </div>
    );
  }

  const shown = all ? team.questions : team.questions.slice(0, 2);
  const facts = [
    team.lastMerge && `Last merge ${shortDate(team.lastMerge.at)}: ${team.lastMerge.text}`,
    team.usage && `${formatCost(team.usage.cost)} so far · ${formatTokens(
      team.usage.input + team.usage.output + team.usage.cacheRead)} tokens · ${team.usage.roles} role${
      team.usage.roles === 1 ? '' : 's'}`,
  ].filter(Boolean) as string[];
  if (shown.length === 0 && facts.length === 0) return null;

  return (
    <div className="space-y-2 border-b border-border px-4 py-3">
      {shown.map((m) => (
        <div key={m.id}>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            {m.question?.proposal && <GitMerge className="h-3 w-3 text-primary" />} {m.label}
          </p>
          {m.text && (
            <p className="mb-1.5 line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
              <Linked text={m.text} />
            </p>
          )}
          {m.question && (
            <QuestionCard compact messageId={m.id} question={m.question} state={m.questionState}
                          outcome={m.outcome} request={m.request} onAnswered={reload} />
          )}
        </div>
      ))}
      {team.questions.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="text-xs font-medium text-primary">
          {team.questions.length - shown.length} more waiting
        </button>
      )}
      {facts.length > 0 && (
        <button type="button" onClick={onOpenAgents}
                className="block w-full space-y-0.5 text-left text-xs text-muted-foreground">
          {facts.map((f) => <span key={f} className="block truncate">{f}</span>)}
        </button>
      )}
    </div>
  );
}
