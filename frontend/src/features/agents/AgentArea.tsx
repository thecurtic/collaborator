import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ExternalLink,
  FileText,
  History,
  Loader2,
  PauseCircle,
  Send,
  Star,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  agentsApi,
  connectAgentsLive,
  toRequest,
  isWebUrl,
  toChannel,
  toMessage,
  type AgentChannel,
  type AgentMessage,
  type AgentProjectDetail,
  type FirehoseItem,
} from '@/api/agents';
import { JumpToLatest } from '@/components/JumpToLatest';
import { Linked } from '@/components/Linked';
import { Button } from '@/components/ui/button';
import { useScrollHold } from '@/lib/useScrollHold';
import { cn } from '@/lib/utils';
import { QuestionCard } from './QuestionCard';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

type Ref = { endpointId: string; channel: string };
const keyOf = (c: Ref) => `${c.endpointId}\u0001${c.channel}`;

function since(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return ` since ${t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function HealthBadge({ detail }: { detail: AgentProjectDetail }) {
  const [open, setOpen] = useState(false);
  const h = detail.health;
  if (h.state === 'ok') return null;
  const paused = h.state === 'paused';
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
              aria-label={paused ? 'Paused by you' : 'An endpoint is degraded'}
              className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                paused ? 'bg-muted text-muted-foreground' : 'bg-amber-500/15 text-amber-700 dark:text-amber-400')}>
        {paused ? <PauseCircle className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {paused ? 'Paused' : 'Degraded'}
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-64 rounded-lg border border-border bg-background p-3 text-xs shadow-lg">
          {paused ? (
            <p>Paused by you with the inference switch. The team picks up when you switch back.</p>
          ) : (
            <ul className="space-y-1.5">
              {h.endpoints.map((e) => (
                <li key={e.id}>
                  <span className="font-medium text-foreground">{e.name}</span>
                  <span className="text-muted-foreground">
                    {' '}· {e.health.state === 'unreachable' ? 'unreachable' : e.health.detail || 'degraded'}
                    {since(e.health.since)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The channel strip, pinned above the conversation: ultra-thin, a dot per
 * channel (pulsing while it's busy). Pulled open, one live line per channel;
 * tapping a line opens that channel.
 */
function ChannelStrip({ channels, onPick }: { channels: AgentChannel[]; onPick: (c: AgentChannel) => void }) {
  const [open, setOpen] = useState(false);
  const startY = useRef<number | null>(null);
  if (channels.length === 0) return null;
  return (
    <div className="border-b border-border bg-muted/30"
         onTouchStart={(e) => { startY.current = e.touches[0].clientY; }}
         onTouchEnd={(e) => {
           if (startY.current == null) return;
           const dy = e.changedTouches[0].clientY - startY.current;
           if (dy > 24) setOpen(true);
           else if (dy < -24) setOpen(false);
           startY.current = null;
         }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
              aria-expanded={open} aria-label={open ? 'Hide channel lines' : 'Show channel lines'}
              className="flex h-6 w-full items-center gap-1.5 px-4">
        {channels.map((c) => (
          <span key={keyOf(c)} title={c.label}
                className={cn('h-1.5 w-1.5 rounded-full',
                  !c.connected ? 'bg-muted-foreground/30'
                    : c.busy ? 'animate-pulse bg-primary' : 'bg-primary/40')} />
        ))}
        <span className="ml-auto text-muted-foreground">
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>
      {open && (
        <ul className="pb-1">
          {channels.map((c) => (
            <li key={keyOf(c)} className="flex items-center gap-2 px-4 py-1 text-xs">
              <button type="button" onClick={() => onPick(c)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
                  c.busy ? 'animate-pulse bg-primary' : 'bg-primary/40')} />
                <span className="shrink-0 font-medium text-foreground">{c.label}</span>
                <span className="min-w-0 truncate text-muted-foreground">{c.status || 'idle'}</span>
              </button>
              {isWebUrl(c.previewUrl) && (
                <a href={c.previewUrl} target="_blank" rel="noopener noreferrer"
                   className="flex shrink-0 items-center gap-1 text-primary">
                  <ExternalLink className="h-3 w-3" /> Preview
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A sent note's message text is the user's words, then the note itself;
 * the bubble shows the words and the note as a chip. */
function noteWords(m: AgentMessage): string {
  if (!m.note) return '';
  const at = m.text.indexOf(`# ${m.note.title}`);
  return (at >= 0 ? m.text.slice(0, at) : '').trim();
}

function MessageRow({ m, onAnswered }: { m: AgentMessage; onAnswered: (m: AgentMessage) => void }) {
  const mine = m.from === 'you';
  if (m.question) {
    return (
      <div className="max-w-[92%]">
        {m.text && <p className="mb-1.5 whitespace-pre-wrap text-sm"><Linked text={m.text} /></p>}
        <QuestionCard messageId={m.id} question={m.question} state={m.questionState}
                      outcome={m.outcome} request={m.request} onAnswered={onAnswered} />
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
      <div className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm',
        mine ? 'rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md bg-muted text-foreground',
        m.needsReply && !mine && 'ring-1 ring-primary/50')}>
        {m.note ? (
          <>
            {noteWords(m) && <p className="mb-1.5 whitespace-pre-wrap break-words">{noteWords(m)}</p>}
            <p className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
              mine ? 'bg-primary-foreground/15' : 'bg-background')}>
              <FileText className="h-3.5 w-3.5 shrink-0" /> {m.note.title}
            </p>
          </>
        ) : (
          <p className="whitespace-pre-wrap break-words"><Linked text={m.text} /></p>
        )}
      </div>
      {mine && !m.deliveredAt && (
        <span className="mt-0.5 text-[10px] text-muted-foreground">Queued until the endpoint takes it</span>
      )}
    </div>
  );
}

/** A follow-the-end scroll area that never fights the reader. */
function useFollow(dep: unknown, mountKey: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const hold = useScrollHold(ref, mountKey);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && hold.mayScroll()) el.scrollTop = el.scrollHeight;
  }, [dep, hold]);
  const jump = () => {
    hold.follow();
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  return { ref, detached: hold.detached, jump };
}

function Firehose({ items, onHistory }: { items: FirehoseItem[]; onHistory: () => void }) {
  const f = useFollow(items.length, 'firehose');
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={f.ref} className="h-full overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[12px] leading-relaxed">
        {items.length === 0 ? (
          <div className="py-10 text-center font-sans text-sm text-muted-foreground">
            <p>Nothing live yet. This view shows activity as it happens.</p>
            <Button variant="ghost" size="sm" onClick={onHistory} className="mt-2 gap-1.5 text-xs">
              <History className="h-3.5 w-3.5" /> Ask for earlier activity
            </Button>
          </div>
        ) : (
          items.map((it, i) =>
            it.kind === 'event' ? (
              <div key={i} className="my-1.5 flex items-center gap-2 rounded bg-primary/10 px-2 py-1 font-sans text-xs text-primary">
                <span className="font-medium">{it.text}</span>
                {isWebUrl(it.url) && (
                  <a href={it.url} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 underline">
                    <ExternalLink className="h-3 w-3" /> Open
                  </a>
                )}
              </div>
            ) : (
              <div key={i} className={cn('whitespace-pre-wrap break-words',
                it.kind === 'thinking' ? 'text-muted-foreground' : 'text-foreground',
                it.replay && 'opacity-70')}>
                {it.kind !== 'text' && <span className="mr-1.5 text-muted-foreground">[{it.kind}]</span>}
                {it.text}
              </div>
            ),
          )
        )}
      </div>
      {f.detached && items.length > 0 && <JumpToLatest onClick={f.jump} />}
    </div>
  );
}

function Conversation({ messages, onAnswered }: { messages: AgentMessage[]; onAnswered: (m: AgentMessage) => void }) {
  const f = useFollow(messages.length + ':' + (messages.at(-1)?.questionState ?? ''), 'conversation');
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={f.ref} className="flex h-full flex-col gap-2 overflow-y-auto overscroll-contain px-3 py-3">
        {messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nothing said here yet. Write below, or send a note from its note view.
          </p>
        ) : (
          messages.map((m) => <MessageRow key={m.id} m={m} onAnswered={onAnswered} />)
        )}
      </div>
      {f.detached && <JumpToLatest onClick={f.jump} />}
    </div>
  );
}

function Composer({ channel, onSend }: { channel: AgentChannel; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(t);
      setText('');
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-border px-3 py-2">
      {channel.busy && (
        <p className="mb-1.5 text-[11px] text-muted-foreground">
          {channel.label} is mid-turn: your message is {channel.midturnInput === 'steers'
            ? 'delivered into its current turn'
            : 'queued and answered after the current turn'}.
        </p>
      )}
      {!channel.connected && (
        <p className="mb-1.5 text-[11px] text-muted-foreground">
          The endpoint is offline: your message goes when it reconnects.
        </p>
      )}
      <div className="flex items-end gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1}
                  placeholder={`Message ${channel.label}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  className="max-h-40 min-h-10 flex-1 resize-none rounded-2xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
        <Button size="icon" aria-label="Send" disabled={busy || !text.trim()} onClick={() => void send()}
                className="h-10 w-10 rounded-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * A project's agent area (agent doc, How Collaborator renders it): the
 * default channel's conversation is the landing screen, the other channels
 * sit around it as passive awareness (the strip) and as tabs. Labels come
 * from the backend as plain text; nothing here names a role.
 */
export function AgentArea({
  tag,
  initialChannel,
  onBack,
}: {
  tag: string;
  /** Open on this channel (a Feed card, a search hit), else the default. */
  initialChannel?: Ref | null;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<AgentProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialChannel ? keyOf(initialChannel) : null);
  const [messages, setMessages] = useState<Record<string, AgentMessage[]>>({});
  const [firehose, setFirehose] = useState<Record<string, FirehoseItem[]>>({});
  const [zoom, setZoom] = useState<Record<string, boolean>>({});
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadDetail = useCallback(async () => {
    try {
      const d = await agentsApi.project(tag);
      setDetail(d);
      setError(null);
      setSelected((cur) => {
        if (cur && d.channels.some((c) => keyOf(c) === cur)) return cur;
        const first = d.default ?? d.channels[0] ?? null;
        return first ? keyOf(first) : null;
      });
    } catch (err) {
      setError(errMessage(err));
    }
  }, [tag]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const channel = useMemo(
    () => detail?.channels.find((c) => keyOf(c) === selected) ?? null, [detail, selected]);

  const loadChannel = useCallback(async (c: AgentChannel) => {
    const k = keyOf(c);
    try {
      if (c.acceptsInput || !c.firehose) {
        const ms = await agentsApi.messages(tag, c);
        setMessages((prev) => ({ ...prev, [k]: ms }));
      }
      if (c.firehose) {
        const items = await agentsApi.firehose(tag, c);
        setFirehose((prev) => ({ ...prev, [k]: items }));
      }
      if (c.unread > 0) {
        await agentsApi.read(tag, c);
        void loadDetail();   // flagged messages stop waiting; open questions don't
      }
    } catch (err) {
      setError(errMessage(err));
    }
  }, [tag, loadDetail]);

  const channelKey = channel ? keyOf(channel) : null;
  const channelRef = useRef(channel);
  channelRef.current = channel;
  useEffect(() => {
    // Only when the selection changes, not on every status line.
    if (channelRef.current) void loadChannel(channelRef.current);
  }, [channelKey, loadChannel]);

  const detailRef = useRef(detail);
  detailRef.current = detail;

  // Live updates for this project; on reconnect, reload what's shown.
  useEffect(() => {
    return connectAgentsLive((e) => {
      if (e.type === 'health' || e.type === 'endpoint' || e.type === 'discovery' ||
          e.type === 'channel_removed') {
        void loadDetail();
        return;
      }
      if (e.type === 'request' && e.request) {
        // A merge request's progress shows on its question card.
        const r = toRequest(e.request);
        if (r.messageId == null) return;
        setMessages((prev) => Object.fromEntries(Object.entries(prev).map(([k, list]) =>
          [k, list.map((x) => (x.id === r.messageId ? { ...x, request: r } : x))])));
        return;
      }
      if (e.project !== tag) return;
      if (e.type === 'message') {
        const m = toMessage(e.message);
        const k = keyOf(m);
        setMessages((prev) => {
          const list = prev[k] ?? [];
          const i = list.findIndex((x) => x.id === m.id);
          return { ...prev, [k]: i >= 0 ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m] };
        });
        if (m.from === 'agent' && k === selectedRef.current && !m.readAt) {
          void agentsApi.read(tag, m);
        }
      } else if (e.type === 'channel' || (e.type === 'event' && e.channel_state)) {
        const c = toChannel(e.type === 'channel' ? e.channel : e.channel_state);
        setDetail((d) => {
          if (!d) return d;
          const exists = d.channels.some((x) => keyOf(x) === keyOf(c));
          if (!exists) {
            void loadDetail();
            return d;
          }
          return { ...d, channels: d.channels.map((x) => keyOf(x) === keyOf(c)
            ? { ...x, ...c, endpointName: x.endpointName, unread: x.unread, waiting: x.waiting,
                connected: x.connected } : x) };
        });
      }
      if ((e.type === 'firehose' || e.type === 'event') && e.channel && e.item) {
        const k = keyOf({ endpointId: e.endpoint_id, channel: e.channel });
        setFirehose((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), e.item as FirehoseItem].slice(-1000) }));
      }
    }, () => {
      void loadDetail();
      const c = detailRef.current?.channels.find((x) => keyOf(x) === selectedRef.current);
      if (c) void loadChannel(c);
    });
  }, [tag, loadDetail, loadChannel]);

  const onAnswered = (m: AgentMessage) => {
    const k = keyOf(m);
    setMessages((prev) => ({ ...prev, [k]: (prev[k] ?? []).map((x) => (x.id === m.id ? m : x)) }));
  };

  const inputs = detail?.channels.filter((c) => c.acceptsInput) ?? [];
  const isDefault = (c: AgentChannel) =>
    !!detail?.default && keyOf(detail.default) === keyOf(c);
  const ordered = detail
    ? [...detail.channels].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)))
    : [];

  const makeDefault = async (c: AgentChannel) => {
    try {
      await agentsApi.setDefault(tag, c);
      setDetail((d) => d && { ...d, default: { endpointId: c.endpointId, channel: c.channel } });
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const showFirehose = channel
    ? channel.firehose && (!channel.acceptsInput || zoom[keyOf(channel)])
    : false;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-3">
        <Button variant="ghost" size="icon" aria-label="Back to the project" onClick={onBack} className="h-9 w-9">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{tag}</h2>
        {detail && <HealthBadge detail={detail} />}
      </div>
      {detail && (
        <ChannelStrip channels={ordered} onPick={(c) => setSelected(keyOf(c))} />
      )}
      {detail && detail.channels.length > 1 && (
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
          {ordered.map((c) => {
            const k = keyOf(c);
            const badge = c.waiting || (k !== selected ? c.unread : 0);
            return (
              <button key={k} type="button" role="tab" aria-selected={k === selected}
                      onClick={() => setSelected(k)}
                      className={cn('flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium',
                        k === selected ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}>
                {c.label}
                {badge > 0 && (
                  <span className={cn('rounded-full px-1 text-[9px] leading-[14px]',
                    c.waiting ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/20')}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {error && <p className="px-4 py-2 text-xs text-destructive">{error}</p>}
      {detail === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !channel ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          The backend hasn't declared any channels for this project yet.
        </p>
      ) : (
        <>
          {(isWebUrl(channel.previewUrl) || (channel.acceptsInput && channel.firehose) ||
            (channel.acceptsInput && inputs.length > 1 && !isDefault(channel))) && (
            <div className="flex items-center gap-3 border-b border-border px-4 py-1.5 text-xs">
              {isWebUrl(channel.previewUrl) && (
                <a href={channel.previewUrl} target="_blank" rel="noopener noreferrer"
                   className="flex min-w-0 items-center gap-1 text-primary">
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{channel.previewText || 'Open preview'}</span>
                </a>
              )}
              <span className="ml-auto flex items-center gap-3">
                {channel.acceptsInput && inputs.length > 1 && !isDefault(channel) && (
                  <button type="button" onClick={() => void makeDefault(channel)}
                          className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    <Star className="h-3.5 w-3.5" /> Make default
                  </button>
                )}
                {channel.acceptsInput && channel.firehose && (
                  <button type="button" onClick={() => setZoom((z) => ({ ...z, [keyOf(channel)]: !z[keyOf(channel)] }))}
                          className="font-medium text-muted-foreground hover:text-foreground">
                    {showFirehose ? 'Conversation' : 'Activity'}
                  </button>
                )}
              </span>
            </div>
          )}
          {showFirehose ? (
            <Firehose items={firehose[keyOf(channel)] ?? []}
                      onHistory={() => void agentsApi.history(tag, channel, 0).catch((err) => setError(errMessage(err)))} />
          ) : (
            <Conversation messages={messages[keyOf(channel)] ?? []} onAnswered={onAnswered} />
          )}
          {channel.acceptsInput && !showFirehose && (
            <Composer channel={channel} onSend={async (text) => {
              const m = await agentsApi.send(tag, channel, text);
              setMessages((prev) => {
                const list = prev[keyOf(channel)] ?? [];
                return list.some((x) => x.id === m.id) ? prev
                  : { ...prev, [keyOf(channel)]: [...list, m] };
              });
            }} />
          )}
        </>
      )}
    </div>
  );
}
