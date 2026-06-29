import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Composer } from './Composer';
import { TreeBubble } from './TreeBubble';
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
  const { path, loading, sending, error, streaming, send, branch, switchSibling } =
    useConversation(reloadSignal);
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

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
    if (!loading && pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [path.length, streaming?.reply, sending, loading]);

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

  return (
    <div className="flex h-full flex-col">
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
            path.map((entry) => {
              const idx = entry.siblings.findIndex(
                (s) => s.id === entry.node.id,
              );
              return (
                <div key={entry.node.id} className="flex flex-col gap-1">
                  {entry.siblings.length > 1 && (
                    <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                      <button
                        type="button"
                        aria-label="Previous branch"
                        onClick={() =>
                          switchSibling(entry.parentId, entry.siblings, -1)
                        }
                        className="rounded p-0.5 hover:text-foreground active:scale-90"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span>
                        {idx + 1} / {entry.siblings.length}
                      </span>
                      <button
                        type="button"
                        aria-label="Next branch"
                        onClick={() =>
                          switchSibling(entry.parentId, entry.siblings, 1)
                        }
                        className="rounded p-0.5 hover:text-foreground active:scale-90"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  <TreeBubble node={entry.node} onBranch={handleBranch} />
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
