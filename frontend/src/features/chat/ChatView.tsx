import { Brain, Link as LinkIcon, Loader2, NotebookPen } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { useModalA11y } from '@/lib/useModalA11y';
import { useDebugEnabled } from '@/features/settings/uiPrefs';
import type { RecallBlock } from '@/domain/models';
import type { BranchTarget } from './branchTarget';
import { Composer, type ComposerHandle } from './Composer';
import { quoteForReply } from './quote';
import { TreeBubble, UserText, type ShareScope } from './TreeBubble';
import type { Conversation, PathEntry } from './useConversation';
import { ActivityRow } from '@/components/ActivityRow';
import type { TreeNode } from '@/domain/models';

interface ChatViewProps {
  /** Conversation state/actions, owned by the app shell (shared with tabs). */
  convo: Conversation;
  /** Shared with App so a call can fork from the same point. */
  branchTarget: BranchTarget | null;
  onBranchTargetChange: (b: BranchTarget | null) => void;
  /** Open the drafts inbox (filtered to a run) — model-proposed notes. */
  onReviewDrafts: (runId: string | null) => void;
  /** Start a voice call (button lives in the composer). */
  onStartCall: () => void;
  /** Prefill the composer (chats spawned from web search); nonce re-triggers. */
  draftSeed?: { text: string; nonce: number } | null;
  /** MUST clear draftSeed — ChatView remounts per chat, so an unconsumed
      seed would prefill every subsequent chat. */
  onDraftSeedConsumed?: () => void;
}

/** Plain-text export of a run of turns (for sharing the context window). */
function formatTurns(entries: PathEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.node.role === 'user' ? 'You' : 'Collaborator'}:\n${e.node.content}`,
    )
    .join('\n\n---\n\n');
}

interface BranchPoint {
  turnId: number;
  paragraphIndex?: number;
  label: string;
}

/** The recalled-memory block: rendered between a user message and its reply. */
function RecallCard({ recall }: { recall: RecallBlock }) {
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary">
        <Brain className="h-3.5 w-3.5" />
        Recalled memory
        {recall.sources.length > 0 && (
          <span className="text-muted-foreground">
            · {recall.sources.length}{' '}
            {recall.sources.length === 1 ? 'source' : 'sources'}
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words text-card-foreground">
        {recall.content}
      </p>
      {recall.sources.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Sources</summary>
          <ul className="mt-1 space-y-1">
            {recall.sources.map((s) => (
              <li key={s.turnId} className="truncate">
                <span className="opacity-70">#{s.turnId}</span> {s.preview}
                {s.tags.length > 0 && (
                  <span className="text-primary"> · {s.tags.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ChatView({
  convo,
  branchTarget,
  onBranchTargetChange,
  onReviewDrafts,
  onStartCall,
  draftSeed = null,
  onDraftSeedConsumed,
}: ChatViewProps) {
  const {
    path,
    loading,
    sending,
    error,
    contextWindow,
    streaming,
    recall,
    activity,
    proposedDrafts,
    clearProposedDrafts,
    unfollowedLinks,
    send,
    branch,
    editResend,
    stopGeneration,
    cycleFork,
    remove,
  } = convo;
  // Gates the in-flight recall-block card (diagnostic display, 9aee10b).
  const debug = useDebugEnabled();
  // Pending branch point awaiting a with/without-context choice.
  const [branchChoice, setBranchChoice] = useState<BranchPoint | null>(null);
  // Regenerate: the leaf reply to replace — the next send deletes the old
  // exchange and resends the (possibly edited) draft. Nothing is deleted
  // until the user actually sends, so cancelling is free.
  const [editTarget, setEditTarget] = useState<number | null>(null);
  // Transient feedback (e.g. "Copied to clipboard" when share falls back).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (msg: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(msg);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  };
  const branchDialogRef = useModalA11y<HTMLDivElement>(branchChoice !== null, () =>
    setBranchChoice(null),
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const suppressScrollRef = useRef(false);
  const composerRef = useRef<ComposerHandle>(null);
  // Top of the streaming response (the optimistic user bubble) — following
  // stops once this scrolls off-screen, so a long answer stays readable
  // from its start.
  const streamTopRef = useRef<HTMLDivElement>(null);
  // Follow-the-stream state machine:
  //   'auto'    — follow, but stop when the response start leaves the screen
  //   'stopped' — don't follow (auto-stop above, or the user scrolled up)
  //   'user'    — user deliberately returned to the bottom: always follow
  const followRef = useRef<'auto' | 'stopped' | 'user'>('auto');
  // Our own scrollIntoView fires scroll events indistinguishable from the
  // user's — flag them so they can't re-pin the view (the old "fighting").
  const programmaticRef = useRef(false);

  const scrollToBottom = (smooth: boolean) => {
    programmaticRef.current = true;
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: 'end',
    });
    setTimeout(() => {
      programmaticRef.current = false;
    }, smooth ? 350 : 80);
  };

  // Reply button on a paragraph: stack a truncated quote into the draft.
  const handleQuote = (text: string) => {
    composerRef.current?.appendQuote(quoteForReply(text));
  };

  // Prefill from web search ("chat about this page" / "ask about query").
  // Consume-once: this effect fires on every mount (ChatView remounts per
  // chat), so the seed must be cleared upstream after it's applied.
  useEffect(() => {
    if (draftSeed) {
      composerRef.current?.setDraft(draftSeed.text);
      onDraftSeedConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSeed?.nonce]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || programmaticRef.current) return;
    // A real user scroll: away from the bottom stops following for the rest
    // of the turn; deliberately returning to the bottom re-engages it.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    followRef.current = nearBottom ? 'user' : 'stopped';
  };

  // Jump to the newest message when the screen opens (mount) / finishes loading.
  useLayoutEffect(() => {
    if (!loading) {
      followRef.current = 'auto';
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [loading]);

  // Each new turn starts following afresh.
  useEffect(() => {
    if (sending) followRef.current = 'auto';
  }, [sending]);

  // Follow new/streaming content per the follow state — but not when
  // switching branch forks (keep the tapped toggle under the finger).
  useEffect(() => {
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false;
      return;
    }
    if (loading || followRef.current === 'stopped') return;
    if (followRef.current === 'auto' && streaming) {
      // Auto-stop once the response start would scroll off-screen, so a long
      // answer stays readable from the top without any user action.
      const container = scrollRef.current;
      const top = streamTopRef.current;
      if (container && top) {
        const wouldScrollOff =
          top.getBoundingClientRect().top <
          container.getBoundingClientRect().top;
        if (wouldScrollOff) {
          followRef.current = 'stopped';
          return;
        }
      }
    }
    // Instant during streaming: smooth animations pile up across rapid
    // tokens and were the main source of scroll fighting.
    scrollToBottom(!streaming);
  }, [path.length, streaming?.reply, streaming, activity.length, sending, loading]);

  // Cycle a node's branch fork (keeps the tapped button under the finger).
  const switchFork = (parentId: number, dir: 1 | -1) => {
    suppressScrollRef.current = true;
    cycleFork(parentId, dir);
  };

  // Regenerate: prefill the composer with the user message for editing.
  const startEdit = (assistantId: number, userText: string) => {
    onBranchTargetChange(null); // regenerate and branch are mutually exclusive
    setEditTarget(assistantId);
    composerRef.current?.setDraft(userText);
  };

  // Resolves false on failure so the composer can restore the lost draft.
  const handleSend = (message: string): Promise<boolean> => {
    if (editTarget != null) {
      const target = editTarget;
      setEditTarget(null);
      return editResend(target, message);
    }
    if (branchTarget) {
      const result = branch(
        branchTarget.turnId,
        message,
        branchTarget.paragraphIndex,
        branchTarget.withContext,
      );
      onBranchTargetChange(null);
      return result;
    }
    return send(message);
  };

  // Tapping a branch button asks with/without context first.
  const handleBranch = (
    turnId: number,
    paragraphIndex: number | undefined,
    label: string,
  ) => {
    setBranchChoice({ turnId, paragraphIndex, label: label.slice(0, 80) });
  };

  const chooseContext = (withContext: boolean) => {
    if (branchChoice) onBranchTargetChange({ ...branchChoice, withContext });
    setBranchChoice(null);
    setEditTarget(null); // branch and regenerate are mutually exclusive
  };

  const handleDelete = (turnId: number) => {
    if (window.confirm('Delete this turn? This is permanent.')) {
      void remove(turnId, false);
    }
  };

  // A without-context branch is a fresh chat: show only from its start (the most
  // recent branched context-boundary on the path) down to the tip, hiding the
  // prior thread that the model can't see anyway.
  let freshStart = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].node.branched && path[i].node.contextBoundary) {
      freshStart = i;
      break;
    }
  }
  const displayPath = freshStart > 0 ? path.slice(freshStart) : path;
  // In-context turns = the last `contextWindow` turns of the (fresh) shown path.
  const inCtxStart =
    contextWindow != null
      ? Math.max(0, displayPath.length - contextWindow)
      : 0;

  // Share a single turn or the current context window as plain text; falls
  // back to the clipboard where the Web Share API is unavailable (desktop).
  const handleShare = async (node: TreeNode, scope: ShareScope) => {
    const text =
      scope === 'turn' ? node.content : formatTurns(displayPath.slice(inCtxStart));
    try {
      if (navigator.share) {
        await navigator.share({ text });
      } else {
        await navigator.clipboard.writeText(text);
        showNotice('Copied to clipboard');
      }
    } catch {
      /* user cancelled the share sheet — not an error */
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* Branch context choice. */}
      {branchChoice && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <button
            aria-label="Cancel"
            onClick={() => setBranchChoice(null)}
            className="absolute inset-0 bg-black/60"
          />
          <div
            ref={branchDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Branch from here"
            tabIndex={-1}
            className="pb-safe relative w-full rounded-t-2xl border border-border bg-card p-5 outline-none sm:max-w-sm sm:rounded-2xl"
          >
            <p className="mb-1 text-sm font-medium">Branch from here</p>
            <p className="mb-4 truncate text-xs text-muted-foreground">
              {branchChoice.label}
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => chooseContext(true)}
                className="rounded-lg border border-border px-4 py-3 text-left text-sm hover:bg-muted active:scale-[0.99]"
              >
                <span className="font-medium">Branch with context</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Keeps the conversation history in context.
                </span>
              </button>
              <button
                type="button"
                onClick={() => chooseContext(false)}
                className="rounded-lg border border-border px-4 py-3 text-left text-sm hover:bg-muted active:scale-[0.99]"
              >
                <span className="font-medium">Branch without context</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Fresh start — the model gets no prior history.
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-5 sm:gap-4 sm:px-4 sm:py-6">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading conversation…
            </div>
          ) : path.length === 0 && !streaming ? (
            <div className="py-16 text-center text-muted-foreground">
              <p className="text-lg font-medium text-foreground">
                Start a conversation
              </p>
              <p className="mt-1 text-sm">
                New chats start as seeds — promote the good ones later.
              </p>
            </div>
          ) : (
            displayPath.map((entry, i) => {
              // Regenerate is leaf-exchange only: the reply has no children
              // and its user turn has no other branches — otherwise deleting
              // the pair would destroy downstream turns.
              const prev = i > 0 ? displayPath[i - 1] : undefined;
              const canRegenerate =
                entry.node.role === 'assistant' &&
                entry.node.children.length === 0 &&
                prev?.node.role === 'user' &&
                prev.node.children.length === 1;
              // The switcher (incl. the empty "continue here" slot) is computed
              // per node in useConversation; highlight its source paragraph.
              const fork = entry.fork
                ? {
                    paragraphIndex: entry.fork.paragraphIndex,
                    current: entry.fork.current,
                    total: entry.fork.total,
                    name: entry.fork.name,
                    onPrev: () => switchFork(entry.node.id, -1),
                    onNext: () => switchFork(entry.node.id, 1),
                  }
                : undefined;
              return (
                <div
                  key={entry.node.id}
                  data-tid={entry.node.id}
                  className="flex flex-col gap-3 sm:gap-4"
                >
                  <TreeBubble
                    node={entry.node}
                    onBranch={handleBranch}
                    onDelete={handleDelete}
                    onQuote={handleQuote}
                    onShare={(scope) => void handleShare(entry.node, scope)}
                    onRegenerate={
                      canRegenerate && prev
                        ? () => startEdit(entry.node.id, prev.node.content)
                        : undefined
                    }
                    fork={fork}
                    inContext={i >= inCtxStart}
                  />
                  {/* This turn's stored recall (between the message and reply). */}
                  {entry.node.recall && <RecallCard recall={entry.node.recall} />}
                </div>
              );
            })
          )}

          {/* Optimistic streaming overlay while a send/branch is in flight. */}
          {streaming && (
            <>
              <div ref={streamTopRef} className="flex w-full justify-end">
                <div className="max-w-[85%] rounded-2xl bg-primary px-3.5 py-2.5 text-[15px] leading-relaxed text-primary-foreground sm:max-w-[80%] sm:text-sm">
                  <UserText text={streaming.user} />
                </div>
              </div>
              {/* In-flight recall: between the user message and the reply.
                  Every semantic fire produces a block now (9aee10b) — shown
                  only with Developer diagnostics on, per the contract. */}
              {recall && debug && <RecallCard recall={recall} />}
              <div className="flex w-full justify-start">
                <div className="w-full rounded-2xl border border-border bg-card px-3.5 py-2.5 text-[15px] leading-relaxed text-card-foreground sm:text-sm">
                  {/* Live tool activity: one row per call, resolved in place
                      (✓ n results / ∅ / ✕ reason). Persists while the answer
                      streams below it. */}
                  {activity.length > 0 && (
                    <div className="mb-2 space-y-1 border-b border-border/60 pb-2">
                      {activity.map((item) => (
                        <ActivityRow key={item.id} item={item} />
                      ))}
                    </div>
                  )}
                  {streaming.reply ? (
                    <Markdown>{streaming.reply}</Markdown>
                  ) : (
                    <span className="flex gap-1 py-1" aria-label="Responding">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50 [animation-delay:-0.3s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50 [animation-delay:-0.15s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50" />
                    </span>
                  )}
                </div>
              </div>
            </>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {error && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
          {error}
        </div>
      )}

      {notice && (
        <div className="border-t border-border bg-muted/60 px-4 py-1.5 text-center text-xs text-muted-foreground">
          {notice}
        </div>
      )}

      {/* The model hit its per-turn fetch budget with links left unread —
          one-tap follow-ups (a new message starts a fresh budget). */}
      {unfollowedLinks.length > 0 && !sending && (
        <div className="border-t border-border bg-muted/40 px-4 py-2">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <LinkIcon className="h-3.5 w-3.5 shrink-0" />
            {unfollowedLinks.length === 1
              ? 'One link left unread'
              : `${unfollowedLinks.length} links left unread`}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unfollowedLinks.slice(0, 4).map((url) => {
              let host = url;
              try {
                host = new URL(url).hostname.replace(/^www\./, '');
              } catch {
                /* keep raw */
              }
              return (
                <button
                  key={url}
                  type="button"
                  title={url}
                  onClick={() => void send(`Please read ${url}`)}
                  className="max-w-[12rem] truncate rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:border-primary/50"
                >
                  {host}
                </button>
              );
            })}
            {unfollowedLinks.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  void send(
                    `Yes — please read the remaining links:\n${unfollowedLinks.join('\n')}`,
                  )
                }
                className="rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Read all
              </button>
            )}
          </div>
        </div>
      )}

      {/* The model proposed note(s) this turn — pending drafts, never written
          to the vault without approval. */}
      {proposedDrafts.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const runId = proposedDrafts[0]?.runId || null;
            clearProposedDrafts();
            onReviewDrafts(runId);
          }}
          className="flex items-center justify-center gap-2 border-t border-primary/30 bg-primary/5 px-4 py-2.5 text-sm text-primary hover:bg-primary/10"
        >
          <NotebookPen className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">
            {proposedDrafts.length === 1
              ? proposedDrafts[0].kind === 'edit'
                ? `Edit proposed for “${proposedDrafts[0].targetTitle ?? proposedDrafts[0].title}”`
                : `Note proposed: “${proposedDrafts[0].title}”`
              : `${proposedDrafts.length} note proposals`}
          </span>
          <span className="shrink-0 font-medium underline underline-offset-2">
            Review
          </span>
        </button>
      )}

      <div className="mx-auto w-full max-w-3xl">
        <Composer
          ref={composerRef}
          disabled={sending}
          onSend={handleSend}
          onStop={stopGeneration}
          onStartCall={onStartCall}
          branchLabel={
            editTarget != null
              ? 'Regenerating — edit your message (or send as-is); replaces the current reply'
              : branchTarget
                ? `${branchTarget.label}${branchTarget.withContext ? '' : ' · no context'}`
                : null
          }
          onCancelBranch={() => {
            if (editTarget != null) setEditTarget(null);
            else onBranchTargetChange(null);
          }}
        />
      </div>
    </div>
  );
}
