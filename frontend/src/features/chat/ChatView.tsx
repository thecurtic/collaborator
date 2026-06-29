import { ChevronLeft, ChevronRight, Loader2, Network } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Composer } from './Composer';
import { TreeBubble } from './TreeBubble';
import { TreeMap } from './TreeMap';
import { useConversation } from './useConversation';

interface ChatViewProps {
  /** Bumped to force a reload (e.g. after returning from call mode). */
  reloadSignal?: number;
}

interface BranchTarget {
  turnId: number;
  paragraphIndex?: number;
  label: string;
}

export function ChatView({ reloadSignal = 0 }: ChatViewProps) {
  const {
    path,
    tree,
    activeIds,
    loading,
    sending,
    error,
    streaming,
    send,
    branch,
    switchSibling,
    selectPathTo,
    remove,
  } = useConversation(reloadSignal);
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null);
  const [mapOpen, setMapOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  // When entering a branch from the map, scroll to that turn (not the bottom).
  const pendingScrollRef = useRef<number | null>(null);

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

  // Follow new/streaming content while pinned to the bottom.
  useEffect(() => {
    if (!loading && pinnedRef.current && pendingScrollRef.current == null) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [path.length, streaming?.reply, sending, loading]);

  // After entering a branch, scroll that turn into view once it's on the path.
  useEffect(() => {
    const id = pendingScrollRef.current;
    if (id == null) return;
    const el = scrollRef.current?.querySelector(`[data-tid="${id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      pendingScrollRef.current = null;
    }
  });

  const enterBranch = (id: number) => {
    selectPathTo(id);
    pinnedRef.current = false;
    pendingScrollRef.current = id;
    setMapOpen(false);
  };

  const handleSend = (message: string) => {
    if (branchTarget) {
      branch(branchTarget.turnId, message, branchTarget.paragraphIndex);
      setBranchTarget(null);
    } else {
      send(message);
    }
  };

  const handleBranch = (
    turnId: number,
    paragraphIndex: number | undefined,
    label: string,
  ) => {
    setBranchTarget({ turnId, paragraphIndex, label: label.slice(0, 80) });
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
                    onClick={() => switchSibling(0, path[0].siblings, -1)}
                    className="rounded p-0.5 hover:text-foreground active:scale-90"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span>
                    {path[0].siblings.findIndex((s) => s.id === path[0].node.id) +
                      1}{' '}
                    / {path[0].siblings.length}
                  </span>
                  <button
                    type="button"
                    aria-label="Next branch"
                    onClick={() => switchSibling(0, path[0].siblings, 1)}
                    className="rounded p-0.5 hover:text-foreground active:scale-90"
                  >
                    <ChevronRight className="h-4 w-4" />
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
                          switchSibling(entry.node.id, child.siblings, -1),
                        onNext: () =>
                          switchSibling(entry.node.id, child.siblings, 1),
                      }
                    : undefined;
                return (
                  <div key={entry.node.id} data-tid={entry.node.id}>
                    <TreeBubble
                      node={entry.node}
                      onBranch={handleBranch}
                      onDelete={handleDelete}
                      fork={fork}
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
          branchLabel={branchTarget?.label ?? null}
          onCancelBranch={() => setBranchTarget(null)}
        />
      </div>
    </div>
  );
}
