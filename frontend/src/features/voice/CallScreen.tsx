import {
  Brain,
  Check,
  Loader2,
  Mic,
  MicOff,
  Link2,
  NotebookPen,
  Paperclip,
  PhoneOff,
  RotateCcw,
  Settings as SettingsIcon,
  Volume2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type Ref } from 'react';
import { ActionSheet } from '@/components/ActionSheet';
import { ActivityRow } from '@/components/ActivityRow';
import { Button } from '@/components/ui/button';
import { useDebugEnabled } from '@/features/settings/uiPrefs';
import { useModalA11y } from '@/lib/useModalA11y';
import { cn } from '@/lib/utils';
import type { BranchTarget } from '@/features/chat/branchTarget';
import type { CallIntro } from '@/features/chat/callIntro';
import { currentParagraphIndex, splitParagraphs } from './speechUtils';
import { AttachmentStrip } from '@/features/attachments/AttachmentViews';
import { useCall, type CallPhase, type CallTurn, type Handover } from './useCall';
import { useWakeLock } from './useWakeLock';

interface CallScreenProps {
  open: boolean;
  onClose: () => void;
  /** If set, the first spoken turn forks from this branch point. */
  branchTarget?: BranchTarget | null;
  /** Active branch leaf to continue from when not branching. */
  activeLeafId?: number | null;
  onBranchConsumed?: () => void;
  /** Fired after a spoken branch is created (the app promotes seed roots). */
  onBranchCreated?: (parentTurnId: number) => void;
  /**
   * Fired as each spoken exchange commits, with the new leaf turn id — the
   * app uses the last one to land the chat on this conversation at call end.
   */
  onLeafChanged?: (leafId: number) => void;
  /** Something to do before the first listen (typed draft / read a reply). */
  intro?: CallIntro | null;
  /** A note draft landed during this call — the app refreshes the badge. */
  onDraftsProposed?: () => void;
  /** Open the settings sheet on top of the call (engine/voice/debug toggles). */
  onOpenSettings?: () => void;
}

interface Range {
  start: number;
  end: number;
}

/**
 * Split a paragraph into styled runs: spoken, not-yet-spoken (faded), and
 * failed (red — TTS couldn't speak it). Offsets are absolute in the turn text.
 */
function paragraphRuns(
  p: string,
  pStart: number,
  read: number,
  failed: Range[],
): { text: string; failed: boolean; read: boolean }[] {
  const rel = (x: number) => Math.min(Math.max(x - pStart, 0), p.length);
  const n = rel(read); // read boundary within this paragraph
  const cuts = new Set<number>([0, p.length, n]);
  for (const r of failed) {
    cuts.add(rel(r.start));
    cuts.add(rel(r.end));
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const runs: { text: string; failed: boolean; read: boolean }[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    if (a >= b) continue;
    const isFailed = failed.some((r) => rel(r.start) <= a && b <= rel(r.end));
    runs.push({ text: p.slice(a, b), failed: isFailed, read: b <= n });
  }
  return runs;
}

const LABELS: Record<CallPhase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening…',
  processing: 'Processing…',
  responding: 'Responding…',
  error: 'Call error',
};

function Turn({
  role,
  text,
  live,
  speaking,
  readChars,
  failedRanges,
  onSkip,
  currentRef,
  shared,
}: {
  role: 'user' | 'assistant';
  text: string;
  live?: boolean;
  /** While true, render read-along (fade the not-yet-spoken remainder). */
  speaking?: boolean;
  readChars?: number;
  /** Char ranges TTS failed to speak (shown red). Absolute in `text`. */
  failedRanges?: Range[];
  /** Tap a paragraph to (re)speak from there. Assistant turns, when idle. */
  onSkip?: (paragraphIndex: number) => void;
  /** Attached to the paragraph currently being read (for follow-scroll). */
  currentRef?: Ref<HTMLParagraphElement>;
  /** User turns: what was handed over with it. */
  shared?: CallTurn['shared'];
}) {
  const label = role === 'user' ? 'You' : 'Collaborator';

  let body;
  if (role === 'assistant' && onSkip) {
    // Tappable paragraphs (tap to (re)speak from here) with per-paragraph
    // read-along fade while this turn is being spoken. Everything counts as
    // "read" once the turn isn't speaking, except failed (red) ranges.
    const read = speaking ? (readChars ?? 0) : text.length;
    const paras = splitParagraphs(text);
    const failed = failedRanges ?? [];
    // The paragraph currently being read (for follow-scroll).
    const currentIdx = speaking ? currentParagraphIndex(text, read) : -1;
    body = (
      <div className="space-y-2">
        {paras.map(({ text: p, start }, i) =>
          p.trim() ? (
            <p
              key={i}
              ref={speaking && i === currentIdx ? currentRef : undefined}
              onClick={() => onSkip(i)}
              title="Tap to play from here"
              className="cursor-pointer whitespace-pre-wrap text-[17px] leading-relaxed transition active:opacity-70"
            >
              {paragraphRuns(p, start, read, failed).map((r, k) => (
                <span
                  key={k}
                  className={cn(
                    r.failed ? 'text-destructive' : 'text-foreground',
                    !r.failed && !r.read && 'opacity-40',
                  )}
                >
                  {r.text}
                </span>
              ))}
            </p>
          ) : null,
        )}
      </div>
    );
  } else {
    body = (
      <p
        className={cn(
          'whitespace-pre-wrap text-[17px] leading-relaxed',
          live ? 'text-foreground/80' : 'text-foreground',
        )}
      >
        {text}
      </p>
    );
  }

  return (
    <div>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {shared && shared.files.length > 0 && (
        <div className="mt-1">
          <AttachmentStrip items={shared.files} />
        </div>
      )}
      {body}
      {shared?.texts.map((t, i) => (
        <p
          key={i}
          className="mt-1.5 line-clamp-3 break-words rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-sm text-muted-foreground"
        >
          {t}
        </p>
      ))}
    </div>
  );
}

export function CallScreen({
  open,
  onClose,
  branchTarget = null,
  activeLeafId = null,
  onBranchConsumed,
  onBranchCreated,
  onLeafChanged,
  intro = null,
  onDraftsProposed,
  onOpenSettings,
}: CallScreenProps) {
  const {
    phase,
    reasoning,
    draftCount,
    partial,
    transcript,
    speakingId,
    spokenChars,
    speakBase,
    failedRanges,
    activity,
    error,
    muted,
    logs,
    endTurn,
    interruptNow,
    end,
    setMuted,
    retry,
    skipTo,
    handover,
    addFiles,
    addText,
    removeHandover,
  } = useCall(
    open,
    onClose,
    branchTarget,
    activeLeafId,
    onBranchConsumed,
    onBranchCreated,
    onLeafChanged,
    intro,
    onDraftsProposed,
  );
  useWakeLock(open); // keep the screen on for the whole call
  const showDebug = useDebugEnabled();
  const bottomRef = useRef<HTMLDivElement>(null);
  const currentParaRef = useRef<HTMLParagraphElement>(null);
  // Dialog semantics + focus trap. Deliberately NO Escape-to-close: a stray
  // keypress must not end an active call — that's the red button's job.
  const dialogRef = useModalA11y<HTMLDivElement>(open);
  const fileRef = useRef<HTMLInputElement>(null);
  const [handMenu, setHandMenu] = useState(false);
  const [textSheet, setTextSheet] = useState(false);

  // Paragraph currently being read — scrolling keys off this (not every
  // sentence tick) so the view doesn't judder mid-paragraph.
  const speakingTurn =
    speakingId != null ? transcript.find((t) => t.id === speakingId) : undefined;
  const currentParaIdx = speakingTurn
    ? currentParagraphIndex(speakingTurn.text, speakBase + spokenChars)
    : -1;

  useEffect(() => {
    // While the agent speaks, keep the paragraph being read in view (centered);
    // otherwise follow the bottom (new user speech / new turns).
    if (speakingId != null && currentParaRef.current) {
      currentParaRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [transcript.length, partial, currentParaIdx, speakingId]);

  if (!open) return null;

  const speaking = phase === 'responding';
  const busy = phase === 'connecting' || phase === 'processing';

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Voice call"
      tabIndex={-1}
      className="pt-safe pb-safe px-safe fixed inset-0 z-50 flex flex-col bg-background outline-none"
    >
      {/* Status indicator — kept up top so the transcript has room below. */}
      <div className="relative flex flex-col items-center gap-2 border-b border-border px-4 py-4">
        {onOpenSettings && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={onOpenSettings}
            className="absolute right-3 top-3 h-8 w-8 text-muted-foreground"
          >
            <SettingsIcon className="h-4 w-4" />
          </Button>
        )}
        <div className="relative flex h-16 w-16 items-center justify-center">
          <span
            className={cn(
              'absolute inset-0 rounded-full',
              phase === 'listening' && 'animate-ping bg-primary/30',
              phase === 'responding' && 'animate-pulse bg-green-500/30',
              phase === 'error' && 'bg-destructive/20',
              busy && 'bg-muted',
            )}
          />
          <span
            className={cn(
              'relative flex h-12 w-12 items-center justify-center rounded-full',
              speaking
                ? 'bg-green-500/20 text-green-500'
                : phase === 'error'
                  ? 'bg-destructive/20 text-destructive'
                  : 'bg-primary/20 text-primary',
            )}
          >
            {busy ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : speaking ? (
              <Volume2 className="h-6 w-6" />
            ) : (
              <Mic className="h-6 w-6" />
            )}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {/* Honest label: during a long think nothing is being generated
              yet — say so instead of "Responding…". */}
          {phase === 'listening' && muted
            ? 'Muted — unmute to talk'
            : phase === 'responding' && reasoning && !speakingTurn?.text
              ? 'Thinking…'
              : LABELS[phase]}
        </p>
        {/* Live chain-of-thought ticker (545e1a5): bottom-anchored tail of
            the newest thinking — glanceable, no interaction needed, never
            spoken, cleared when the next segment starts. */}
        {phase === 'responding' && reasoning && (
          <div className="w-full max-w-md px-2 pt-1">
            <div className="flex items-start gap-1.5 text-[11px] italic leading-snug text-muted-foreground">
              <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
              <div className="flex max-h-16 min-w-0 flex-1 flex-col justify-end overflow-hidden whitespace-pre-wrap break-words">
                {reasoning}
              </div>
            </div>
          </div>
        )}
        {/* Notes proposed during this call — the spoken announcement is
            lossy (barge-in eats it), so this chip is the durable signal. */}
        {draftCount > 0 && (
          <p className="flex items-center gap-1.5 pt-1 text-xs text-primary">
            <NotebookPen className="h-3.5 w-3.5 shrink-0" />
            {draftCount === 1
              ? 'Note proposed'
              : `${draftCount} notes proposed`}{' '}
            — review in Mind after the call
          </p>
        )}
        {/* Live tool activity for this spoken turn (searches, page reads) —
            so you can SEE it working instead of sitting in silence. */}
        {activity.length > 0 && (
          <div className="w-full max-w-md space-y-1 px-2 pt-1">
            {activity.slice(-4).map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      {/* Scrollable conversation — readable while listening or speaking. */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <div className="mx-auto flex max-w-md flex-col gap-5">
          {transcript.map((t) => {
            const isSpeaking = t.id === speakingId;
            return (
              <Turn
                key={t.id}
                role={t.role}
                text={t.text}
                speaking={isSpeaking}
                readChars={speakBase + spokenChars}
                failedRanges={failedRanges.filter((r) => r.turnId === t.id)}
                currentRef={isSpeaking ? currentParaRef : undefined}
                shared={t.shared}
                onSkip={
                  t.role === 'assistant'
                    ? (i) => skipTo(t.id, t.text, i)
                    : undefined
                }
              />
            );
          })}
          {phase === 'listening' && partial && (
            <Turn role="user" text={partial} live />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Diagnostics — toggled via Settings → Developer diagnostics. */}
      {showDebug && logs.length > 0 && (
        <div className="mx-auto max-h-32 w-full max-w-md overflow-y-auto border-t border-border bg-card p-2 font-mono text-[10px] leading-snug text-muted-foreground">
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* Handed over mid-call: goes with whatever is said next. */}
      {handover.length > 0 && (
        <HandoverStrip items={handover} onRemove={removeHandover} />
      )}

      <div className="flex items-center justify-center gap-6 border-t border-border p-6">
        <Button
          variant="secondary"
          size="icon"
          aria-label="Show it something"
          title="Hand over a photo, a file, a link or some text"
          onClick={() => setHandMenu(true)}
          className="h-12 w-12 rounded-full active:scale-95"
        >
          <Paperclip className="h-5 w-5" />
        </Button>
        {phase === 'listening' && (
          <Button
            variant="secondary"
            onClick={endTurn}
            className="h-12 gap-2 rounded-full px-5 active:scale-95"
          >
            <Check className="h-4 w-4" />
            Done speaking
          </Button>
        )}
        {phase === 'responding' && (
          // Manual barge-in — the button twin of the stop word/phrase: cuts
          // the reply off and starts listening immediately.
          <Button
            variant="secondary"
            onClick={interruptNow}
            className="h-12 gap-2 rounded-full px-5 active:scale-95"
          >
            <Mic className="h-4 w-4" />
            Speak now
          </Button>
        )}
        {phase === 'error' && (
          <Button
            variant="secondary"
            onClick={retry}
            className="h-12 gap-2 rounded-full px-5 active:scale-95"
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        )}
        <Button
          variant={muted ? 'default' : 'secondary'}
          size="icon"
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          onClick={() => setMuted(!muted)}
          className="h-12 w-12 rounded-full active:scale-95"
        >
          {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </Button>
        <Button
          variant="destructive"
          size="icon"
          aria-label="End call"
          onClick={end}
          className="h-14 w-14 rounded-full active:scale-95"
        >
          <PhoneOff className="h-6 w-6" />
        </Button>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (list.length) addFiles(list);
        }}
      />
      <ActionSheet
        open={handMenu}
        title="Show it something — it goes with what you say next"
        actions={[
          { label: 'Photo or file', icon: Paperclip, onSelect: () => fileRef.current?.click() },
          { label: 'Text or a link', icon: Link2, onSelect: () => setTextSheet(true) },
        ]}
        onClose={() => setHandMenu(false)}
      />
      <HandTextSheet
        open={textSheet}
        onClose={() => setTextSheet(false)}
        onAdd={(t) => {
          addText(t);
          setTextSheet(false);
        }}
      />
    </div>
  );
}

/** What's been handed over and not said yet: chips, each removable. */
function HandoverStrip({
  items,
  onRemove,
}: {
  items: Handover[];
  onRemove: (key: number) => void;
}) {
  return (
    <div className="border-t border-border px-4 pt-3">
      <p className="mx-auto mb-1.5 max-w-md text-[11px] text-muted-foreground">
        Goes with what you say next
      </p>
      <div className="mx-auto flex max-w-md flex-wrap gap-1.5">
        {items.map((h) => (
          <span
            key={h.key}
            className={cn(
              'flex max-w-full items-center gap-1.5 rounded-lg bg-muted py-1 pl-2.5 pr-1 text-xs',
              h.kind === 'file' && h.status === 'failed' && 'text-destructive',
            )}
          >
            {h.kind === 'file' ? (
              h.status === 'uploading' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
              )
            ) : (
              <Link2 className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="max-w-[14rem] truncate">
              {h.kind === 'file'
                ? h.status === 'failed'
                  ? `${h.name} (upload failed)`
                  : h.name
                : h.text}
            </span>
            <button
              type="button"
              aria-label="Take it back"
              onClick={() => onRemove(h.key)}
              className="rounded p-0.5 hover:bg-background"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Paste (or type) text or a link to hand over. */
function HandTextSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (text: string) => void;
}) {
  const [value, setValue] = useState('');
  const panelRef = useModalA11y<HTMLDivElement>(open, onClose);
  useEffect(() => {
    if (!open) return;
    setValue('');
    // Prefill from the clipboard when the browser allows it.
    navigator.clipboard
      ?.readText?.()
      .then((t) => t && setValue((v) => v || t))
      .catch(() => {});
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Hand over text or a link"
        tabIndex={-1}
        className="pb-safe relative w-full rounded-t-2xl border border-border bg-card p-4 outline-none sm:max-w-md sm:rounded-2xl"
      >
        <p className="mb-2 text-sm font-medium">Text or a link</p>
        <textarea
          autoFocus
          rows={4}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste a link or some text"
          className="w-full resize-none rounded-md border border-input bg-background p-2.5 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button className="flex-1" disabled={!value.trim()} onClick={() => onAdd(value)}>
            Hand it over
          </Button>
        </div>
      </div>
    </div>
  );
}
