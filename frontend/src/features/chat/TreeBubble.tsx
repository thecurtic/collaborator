import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitBranch,
  Globe,
  Layers,
  Loader2,
  MessageSquare,
  RefreshCw,
  Reply,
  Share2,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionSheet } from '@/components/ActionSheet';
import { ActivityRow } from '@/components/ActivityRow';
import { Markdown } from '@/components/Markdown';
import { getTurnSources } from './sourcesStore';
import { Button } from '@/components/ui/button';
import { useSpeech } from '@/features/voice/SpeechContext';
import { splitParagraphs } from '@/features/voice/speechUtils';
import { useLongPress } from '@/lib/useLongPress';
import { useModalA11y } from '@/lib/useModalA11y';
import { cn } from '@/lib/utils';
import type { TreeNode } from '@/domain/models';

export type ShareScope = 'turn' | 'context';

/** Describes the fork at this node: which child paragraph is active + switcher. */
export interface Fork {
  paragraphIndex: number | null;
  /** Displayed numerator: 0 = empty "continue here" slot, 1..n = branches. */
  current: number;
  total: number;
  /** The selected branch's own name (nested under the conversation name). */
  name: string | null;
  onPrev: () => void;
  onNext: () => void;
}

interface TreeBubbleProps {
  node: TreeNode;
  onBranch: (
    turnId: number,
    paragraphIndex: number | undefined,
    label: string,
  ) => void;
  /** subtree=true deletes this turn and everything downstream of it. */
  onDelete: (turnId: number, subtree: boolean) => void;
  /** Quote this paragraph into the composer (stackable multi-quote replies). */
  onQuote?: (text: string) => void;
  /** Share this turn or the current context window (assistant turns). */
  onShare?: (scope: ShareScope) => void;
  /**
   * Regenerate: prefill the composer with the user message for edit-and-
   * resend (replaces this reply). Only passed on the leaf exchange.
   */
  onRegenerate?: () => void;
  /** When set, this node is a fork — highlight the source paragraph + switcher. */
  fork?: Fork;
  /** False → this turn is outside the next message's context window (lighter). */
  inContext?: boolean;
}

/**
 * User message text with quote-reply lines ("> …") rendered as styled quotes,
 * so multi-quote replies read as threads instead of raw markdown.
 */
export function UserText({ text }: { text: string }) {
  return (
    <div className="space-y-0.5">
      {text.split('\n').map((line, i) =>
        line.startsWith('> ') || line === '>' ? (
          <p
            key={i}
            className="whitespace-pre-wrap break-words border-l-2 border-primary-foreground/40 pl-2 text-[13px] italic opacity-85"
          >
            {line.replace(/^> ?/, '')}
          </p>
        ) : line ? (
          <p key={i} className="whitespace-pre-wrap break-words">
            {line}
          </p>
        ) : (
          <div key={i} className="h-2" />
        ),
      )}
    </div>
  );
}

function Switcher({
  current,
  total,
  name,
  onPrev,
  onNext,
}: Omit<Fork, 'paragraphIndex'>) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-xl border border-border bg-background px-1.5 py-1 text-[13px] font-medium text-foreground shadow-sm">
      <GitBranch className="mx-0.5 h-4 w-4 shrink-0 text-primary" />
      <button
        type="button"
        aria-label="Previous branch"
        onClick={onPrev}
        className="shrink-0 rounded-md p-1.5 hover:text-primary active:scale-90"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <span className="min-w-[2.4rem] shrink-0 text-center tabular-nums">
        {current} / {total}
      </span>
      {name && (
        <span className="max-w-[9rem] truncate text-muted-foreground">
          {name}
        </span>
      )}
      <button
        type="button"
        aria-label="Next branch"
        onClick={onNext}
        className="shrink-0 rounded-md p-1.5 hover:text-primary active:scale-90"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </span>
  );
}

/**
 * "Sources" affordance: what the model consulted for this turn (searches,
 * pages read, notes opened), from the client-side per-turn cache. Opens a
 * bottom sheet; page URLs are tappable.
 */
function SourcesButton({ node }: { node: TreeNode }) {
  const [open, setOpen] = useState(false);
  const panelRef = useModalA11y<HTMLDivElement>(open, () => setOpen(false));
  // Server-persisted tool records first (any device); fall back to the
  // local stream-time cache for turns not yet re-fetched with `tools`.
  const persisted = node.tools.length > 0;
  const sources = persisted ? node.tools : getTurnSources(node.id);
  if (sources.length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium underline-offset-2 opacity-70 hover:opacity-100 hover:underline"
      >
        <Globe className="h-3 w-3" />
        Sources · {sources.length}
      </button>
      {open &&
        // Portaled: this button lives in the bubble's dimmed (opacity-60)
        // footer, which would ghost and mis-stack an overlay rendered here.
        createPortal(
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
            <button
              aria-label="Close sources"
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/60"
            />
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Sources"
              tabIndex={-1}
              className="pb-safe relative max-h-[70vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-4 outline-none sm:max-w-sm sm:rounded-2xl"
            >
              <p className="mb-3 text-sm font-medium">
                What the model consulted for this reply
              </p>
              <div className="space-y-2">
                {sources.map((item) => (
                  <ActivityRow key={item.id} item={item} showUrls />
                ))}
              </div>
              {!persisted && (
                <p className="mt-3 text-[10px] text-muted-foreground">
                  Recorded on this device when the reply streamed.
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Copy-to-clipboard icon button with a brief ✓ confirmation. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Copy this turn"
      title="Copy this turn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="-my-1 h-9 w-9 opacity-70 hover:opacity-100"
    >
      {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

// Drag distance (px) that arms the swipe-down subtree delete.
const SUBTREE_DRAG_PX = 48;

/**
 * Delete with a gesture: tap = this turn only (children reparent up); press,
 * drag DOWN past the threshold, release = this turn and everything downstream.
 * The icon turns red while the subtree delete is armed. No confirm dialogs.
 */
function DeleteButton({ onDelete }: { onDelete: (subtree: boolean) => void }) {
  const startY = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Delete this turn (hold and swipe down: with everything after)"
      title="Delete — tap: this turn · hold + swipe down: this turn and everything after"
      onPointerDown={(e) => {
        startY.current = e.clientY;
        setArmed(false);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (startY.current != null) {
          setArmed(e.clientY - startY.current > SUBTREE_DRAG_PX);
        }
      }}
      onPointerUp={(e) => {
        if (startY.current == null) return;
        const subtree = e.clientY - startY.current > SUBTREE_DRAG_PX;
        startY.current = null;
        setArmed(false);
        onDelete(subtree);
      }}
      onPointerCancel={() => {
        startY.current = null;
        setArmed(false);
      }}
      onClick={(e) => {
        // Keyboard activation (Enter/Space) produces a detail-0 click with no
        // preceding pointerup — treat it as a single-turn delete.
        if (e.detail === 0) onDelete(false);
      }}
      className={cn(
        '-my-1 h-9 w-9 touch-none opacity-70 hover:opacity-100',
        armed && 'text-destructive opacity-100',
      )}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );
}

/** Share button: the same bottom ActionSheet as everywhere else in the app. */
function ShareButton({ onShare }: { onShare: (scope: ShareScope) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Share"
        title="Share"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="-my-1 h-9 w-9 opacity-70 hover:opacity-100"
      >
        <Share2 className="h-4 w-4" />
      </Button>
      <ActionSheet
        open={open}
        title="Share"
        actions={[
          {
            label: 'This turn',
            icon: MessageSquare,
            onSelect: () => onShare('turn'),
          },
          {
            label: 'Context window',
            icon: Layers,
            onSelect: () => onShare('context'),
          },
        ]}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export function TreeBubble({
  node,
  onBranch,
  onDelete,
  onQuote,
  onShare,
  onRegenerate,
  fork,
  inContext = true,
}: TreeBubbleProps) {
  const isUser = node.role === 'user';
  // Hold the message text to copy the whole turn (buttons stay tap-only).
  const [copiedAll, setCopiedAll] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copyPress = useLongPress(() => {
    void navigator.clipboard?.writeText(node.content).then(() => {
      setCopiedAll(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedAll(false), 1200);
    });
  });
  const speech = useSpeech();
  const isActive = speech.activeId === node.id;
  const ttsLoading = isActive && speech.status === 'preparing';
  const ttsPlaying = isActive && speech.status === 'speaking';
  const canSpeak = !isUser && !!node.content && speech.supported;

  const multiPara = !isUser && node.paragraphs.length > 1;
  const blocks = multiPara ? node.paragraphs : [node.content];

  // Read-along: while this turn is being spoken, fade the not-yet-read text.
  const reading = isActive;
  const readChars = Math.min(
    speech.speakBase + speech.spokenChars,
    node.content.length,
  );

  // Which block is the fork's source paragraph (highlighted).
  const forkBlock = (i: number) => {
    if (!fork) return false;
    if (fork.paragraphIndex != null) return fork.paragraphIndex === i;
    return blocks.length === 1 && i === 0; // turn-level fork → highlight the block
  };

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'relative rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed sm:text-sm',
          // Agent turns take the full width (margins match left/right); user
          // turns keep the classic right-aligned offset.
          isUser
            ? 'max-w-[85%] bg-primary text-primary-foreground sm:max-w-[80%]'
            : 'w-full border border-border bg-card text-card-foreground',
        )}
      >
        {copiedAll && (
          <span className="absolute -top-2 right-3 z-10 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground shadow">
            Copied
          </span>
        )}
        {reading ? (
          <div className={cn('space-y-1.5', !inContext && 'opacity-60')}>
            {splitParagraphs(node.content).map(({ text: p, start }, i) =>
              p.trim() ? (
                <p
                  key={i}
                  onClick={() => speech.speakFrom(node.id, node.content, i)}
                  title="Tap to play from here"
                  className="cursor-pointer whitespace-pre-wrap break-words active:opacity-70"
                >
                  {(() => {
                    const n = Math.min(Math.max(readChars - start, 0), p.length);
                    return (
                      <>
                        <span>{p.slice(0, n)}</span>
                        {n < p.length && (
                          <span className="opacity-40">{p.slice(n)}</span>
                        )}
                      </>
                    );
                  })()}
                </p>
              ) : null,
            )}
          </div>
        ) : (
          <div className={cn('space-y-1.5', !inContext && 'opacity-60')}>
          {blocks.map((block, i) => {
            const highlighted = forkBlock(i);
            return (
              <div key={i}>
                <div
                  className={cn(
                    'flex items-start gap-1 rounded',
                    highlighted &&
                      'bg-primary/10 px-2 py-1 ring-1 ring-primary/30',
                  )}
                >
                  {/* Hold the text to copy the whole turn. select-none only on
                      touch-first sizes so desktop text selection still works
                      (drag past the tolerance cancels the hold anyway). */}
                  {isUser ? (
                    <div
                      {...copyPress}
                      className="min-w-0 flex-1 select-none [-webkit-touch-callout:none] sm:select-text"
                    >
                      <UserText text={block} />
                    </div>
                  ) : (
                    <div
                      {...copyPress}
                      className="min-w-0 flex-1 select-none [-webkit-touch-callout:none] sm:select-text"
                    >
                      <Markdown>{block}</Markdown>
                    </div>
                  )}
                  <span className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      aria-label="Branch from here"
                      title="Branch from here"
                      onClick={() =>
                        onBranch(
                          node.id,
                          multiPara ? i : undefined,
                          multiPara ? block : node.preview,
                        )
                      }
                      className="mt-0.5 rounded p-2 opacity-50 transition hover:opacity-100 active:scale-90"
                    >
                      <GitBranch className="h-4 w-4" />
                    </button>
                    {!isUser && onQuote && (
                      <button
                        type="button"
                        aria-label="Reply to this paragraph"
                        title="Quote this paragraph in your reply"
                        onClick={() => onQuote(block)}
                        className="rounded p-2 opacity-50 transition hover:opacity-100 active:scale-90"
                      >
                        <Reply className="h-4 w-4" />
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
          </div>
        )}

        {/* Persistent branch switcher — one per fork-turn, always visible. */}
        {fork && (
          <div className="mt-2 flex">
            <Switcher
              current={fork.current}
              total={fork.total}
              name={fork.name}
              onPrev={fork.onPrev}
              onNext={fork.onNext}
            />
          </div>
        )}

        <div className="mt-1.5 flex items-center gap-2 text-[10px] opacity-60">
          {node.paragraphIndex != null && <span>branched</span>}
          {!isUser && <SourcesButton node={node} />}
          <span className="ml-auto flex items-center gap-1.5">
            {canSpeak && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={ttsPlaying ? 'Stop reading' : 'Read aloud'}
                onClick={() => speech.toggle(node.id, node.content)}
                className="-my-1 h-9 w-9 opacity-70 hover:opacity-100"
              >
                {ttsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : ttsPlaying ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
            )}
            {!isUser && onRegenerate && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Regenerate (edit and resend)"
                title="Regenerate — edit your message and resend; replaces this reply"
                onClick={onRegenerate}
                className="-my-1 h-9 w-9 opacity-70 hover:opacity-100"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
            {!isUser && <CopyButton text={node.content} />}
            {!isUser && onShare && <ShareButton onShare={onShare} />}
            <DeleteButton onDelete={(subtree) => onDelete(node.id, subtree)} />
          </span>
        </div>
      </div>
    </div>
  );
}
