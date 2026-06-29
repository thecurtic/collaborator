import { ChevronLeft, ChevronRight, Loader2, Network } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BranchTarget } from './branchTarget';
import { Composer } from './Composer';
import { TreeBubble } from './TreeBubble';
import { TreeMap } from './TreeMap';
import { useConversation } from './useConversation';

interface ChatViewProps {
  /** Bumped to force a reload (e.g. after returning from call mode). */
  reloadSignal?: number;
  /** Shared with App so a call can fork from the same point. */
  branchTarget: BranchTarget | null;
  onBranchTargetChange: (b: BranchTarget | null) => void;
}

interface BranchPoint {
  turnId: number;
  paragraphIndex?: number;
  label: string;
}

export function ChatView({
  reloadSignal = 0,
  branchTarget,
  onBranchTargetChange,
}: ChatViewProps) {
  const {
    path,
    tree,
    activeIds,
    loading,
    sending,
    error,
    contextWindow,
    streaming,
    send,
    branch,
    switchSibling,
    selectPathTo,
    remove,
  } = useConversation(reloadSignal);
  // Pending branch point awaiting a with/without-context choice.
  const [branchChoice, setBranchChoice] = useState<BranchPoint | null>(null);
  const [mapOpen, setMapOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  // Entering a branch jumps to its tip; switching siblings keeps the view put.
  const scrollTipRef = useRef(false);
  const suppressScrollRef = useRef(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Jump to the newest message on load / reload / return.
  useLayoutEffect(() => {
    if (!loading) {
      pinnedRef.current = true;
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [loading, reloadSignal]);

  // Follow new/streaming content while pinned to the bottom — but not when
  // switching siblings (keep the tapped toggle under the finger).
  useEffect(() => {
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false;
      return;
    }
    if (!loading && pinnedRef.current && !scrollTipRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [path.length, streaming?.reply, sending, loading]);

  // After entering a branch, jump to the branch tip (bottom of the new path).
  useEffect(() => {
    if (scrollTipRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      scrollTipRef.current = false;
    }
  });

  const enterBranch = (id: number) => {
    selectPathTo(id);
    pinnedRef.current = true;
    scrollTipRef.current = true;
    setMapOpen(false);
  };

  const switchAt = (
    parentId: number,
    siblings: Parameters<typeof switchSibling>[1],
    dir: 1 | -1,
  ) => {
    suppressScrollRef.current = true;
    switchSibling(parentId, siblings, dir);
  };

  const handleSend = (message: string) => {
    if (branchTarget) {
      branch(
        branchTarget.turnId,
        message,
        branchTarget.paragraphIndex,
        branchTarget.withContext,
      );
      onBranchTargetChange(null);
    } else {
      send(message);
    }
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

  const handleDeleteSubtree = (turnId: number) => {
    if (
      window.confirm('Delete this branch and all its replies? This is permanent.')
    ) {
      void remove(turnId, true);
    }
  };

  // In-context turns = the last `contextWindow` turns of the active path.
  const inCtxStart =
    contextWindow != null ? Math.max(0, path.length - contextWindow) : 0;

  return (
    <div className="relative flex h-full flex-col">
      {!loading && (
        <button
          type="button"
          aria-label="Conversation map"
          title="Conversation map"
          onClick={() => setMapOpen(true)}
          className="absolute right-3 top-3 z-10 rounded-full border border-border bg-card p-2 text-muted-foreground shadow-sm hover:text-foreground active:scale-95"
        >
          <Network className="h-4 w-4" />
        </button>
      )}
      <TreeMap
        open={mapOpen}
        tree={tree}
        activeIds={activeIds}
        onSelect={enterBranch}
        onDeleteSubtree={handleDeleteSubtree}
        onClose={() => setMapOpen(false)}
      />

      {/* Branch context choice. */}
      {branchChoice && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <button
            aria-label="Cancel"
            onClick={() => setBranchChoice(null)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="pb-safe relative w-full rounded-t-2xl border border-border bg-card p-5 sm:max-w-sm sm:rounded-2xl">
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
                Collaborator remembers what matters. Say something below.
              </p>
            </div>
          ) : (
            <>
              {/* Root-level branches (multiple conversation roots). */}
              {path[0] && path[0].siblings.length > 1 && (
                <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                  <button
                    type="button"
                    aria-label="Previous branch"
                    onClick={() => switchAt(0, path[0].siblings, -1)}
                    className="rounded p-1 hover:text-foreground active:scale-90"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <span>
                    {path[0].siblings.findIndex((s) => s.id === path[0].node.id) +
                      1}{' '}
                    / {path[0].siblings.length}
                  </span>
                  <button
                    type="button"
                    aria-label="Next branch"
                    onClick={() => switchAt(0, path[0].siblings, 1)}
                    className="rounded p-1 hover:text-foreground active:scale-90"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </div>
              )}
              {path.map((entry, i) => {
                // The fork lives on this node when its active child has siblings;
                // highlight the source paragraph + show the switcher there.
                const child = path[i + 1];
                const fork =
                  child && child.siblings.length > 1
                    ? {
                        paragraphIndex: child.node.paragraphIndex,
                        index: child.siblings.findIndex(
                          (s) => s.id === child.node.id,
                        ),
                        total: child.siblings.length,
                        onPrev: () =>
                          switchAt(entry.node.id, child.siblings, -1),
                        onNext: () => switchAt(entry.node.id, child.siblings, 1),
                      }
                    : undefined;
                return (
                  <div key={entry.node.id} data-tid={entry.node.id}>
                    <TreeBubble
                      node={entry.node}
                      onBranch={handleBranch}
                      onDelete={handleDelete}
                      fork={fork}
                      inContext={i >= inCtxStart}
                    />
                  </div>
                );
              })}
            </>
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
              <div className="flex w-full justify-start">
                <div className="max-w-[85%] rounded-2xl border border-border bg-card px-3.5 py-2.5 text-[15px] leading-relaxed text-card-foreground sm:max-w-[80%] sm:text-sm">
                  {streaming.reply ? (
                    <p className="whitespace-pre-wrap break-words">
                      {streaming.reply}
                    </p>
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
