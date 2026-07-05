import { Brain, Loader2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { useModalA11y } from '@/lib/useModalA11y';
import type { RecallBlock } from '@/domain/models';
import type { BranchTarget } from './branchTarget';
import { Composer } from './Composer';
import { TreeBubble } from './TreeBubble';
import type { Conversation } from './useConversation';

interface ChatViewProps {
  /** Conversation state/actions, owned by the app shell (shared with tabs). */
  convo: Conversation;
  /** Shared with App so a call can fork from the same point. */
  branchTarget: BranchTarget | null;
  onBranchTargetChange: (b: BranchTarget | null) => void;
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
}: ChatViewProps) {
  const {
    path,
    loading,
    sending,
    error,
    contextWindow,
    streaming,
    recall,
    status,
    send,
    branch,
    stopGeneration,
    cycleFork,
    remove,
  } = convo;
  // Pending branch point awaiting a with/without-context choice.
  const [branchChoice, setBranchChoice] = useState<BranchPoint | null>(null);
  const branchDialogRef = useModalA11y<HTMLDivElement>(branchChoice !== null, () =>
    setBranchChoice(null),
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const suppressScrollRef = useRef(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Jump to the newest message when the screen opens (mount) / finishes loading.
  useLayoutEffect(() => {
    if (!loading) {
      pinnedRef.current = true;
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [loading]);

  // Follow new/streaming content while pinned to the bottom — but not when
  // switching branch forks (keep the tapped toggle under the finger).
  useEffect(() => {
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false;
      return;
    }
    if (!loading && pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [path.length, streaming?.reply, sending, loading]);

  // Cycle a node's branch fork (keeps the tapped button under the finger).
  const switchFork = (parentId: number, dir: 1 | -1) => {
    suppressScrollRef.current = true;
    cycleFork(parentId, dir);
  };

  // Resolves false on failure so the composer can restore the lost draft.
  const handleSend = (message: string): Promise<boolean> => {
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
              // The switcher (incl. the empty "continue here" slot) is computed
              // per node in useConversation; highlight its source paragraph.
              const fork = entry.fork
                ? {
                    paragraphIndex: entry.fork.paragraphIndex,
                    current: entry.fork.current,
                    total: entry.fork.total,
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
              <div className="flex w-full justify-end">
                <div className="max-w-[85%] rounded-2xl bg-primary px-3.5 py-2.5 text-[15px] leading-relaxed text-primary-foreground sm:max-w-[80%] sm:text-sm">
                  <p className="whitespace-pre-wrap break-words">
                    {streaming.user}
                  </p>
                </div>
              </div>
              {/* In-flight recall: between the user message and the reply. */}
              {recall && <RecallCard recall={recall} />}
              <div className="flex w-full justify-start">
                <div className="max-w-[85%] rounded-2xl border border-border bg-card px-3.5 py-2.5 text-[15px] leading-relaxed text-card-foreground sm:max-w-[80%] sm:text-sm">
                  {streaming.reply ? (
                    <Markdown>{streaming.reply}</Markdown>
                  ) : status ? (
                    <span className="text-sm italic text-muted-foreground">
                      {status}
                    </span>
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

      <div className="mx-auto w-full max-w-3xl">
        <Composer
          disabled={sending}
          onSend={handleSend}
          onStop={stopGeneration}
          branchLabel={
            branchTarget
              ? `${branchTarget.label}${branchTarget.withContext ? '' : ' · no context'}`
              : null
          }
          onCancelBranch={() => onBranchTargetChange(null)}
        />
      </div>
    </div>
  );
}
