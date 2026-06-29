import { Loader2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Turn } from '@/domain/models';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { useChat } from './useChat';

// Backend default context window (backend/config.yaml: default_context_window)
// used as a fallback when the API doesn't report the window size.
const DEFAULT_CONTEXT_WINDOW = 5;

interface ChatViewProps {
  /** Bumped to force a history reload (e.g. after returning from call mode). */
  reloadSignal?: number;
}

export function ChatView({ reloadSignal = 0 }: ChatViewProps) {
  const { turns, loading, sending, error, contextWindow, sendMessage, discardTurn, reload } =
    useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom. When the user scrolls up (e.g. to
  // re-read a streaming answer), we stop auto-following so we don't fight them.
  const pinnedRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < 80;
  };

  const scrollToBottom = (behavior: ScrollBehavior) => {
    pinnedRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  };

  // Always open at the newest message: jump instantly (no top→bottom animation)
  // on first load, on reload, and when returning to chat from a call.
  useLayoutEffect(() => {
    if (!loading) scrollToBottom('auto');
  }, [loading, reloadSignal]);

  // During an active session, follow new/streaming content — but only while the
  // user hasn't scrolled up to read.
  const lastTurn = turns[turns.length - 1];
  const tailLength = lastTurn
    ? lastTurn.message.length + lastTurn.response.length
    : 0;
  useEffect(() => {
    if (!loading && pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [turns.length, tailLength, sending, loading]);

  // Reload history when asked (call mode persisted turns while we were away).
  useEffect(() => {
    if (reloadSignal > 0) void reload();
  }, [reloadSignal, reload]);

  // The backend feeds the model the most recent N committed turns; GET only
  // returns committed turns, so the next message's context is simply the last N
  // of what's shown. Highlight that group.
  const windowSize = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextStart = Math.max(0, turns.length - windowSize);
  const olderTurns = turns.slice(0, contextStart);
  const contextTurns = turns.slice(contextStart);

  const renderBubble = (turn: Turn) => (
    <MessageBubble key={turn.id} turn={turn} onDiscard={discardTurn} />
  );

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
          ) : turns.length === 0 ? (
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
              {olderTurns.map(renderBubble)}

              {contextTurns.length > 0 && (
                <div className="flex flex-col gap-3 rounded-2xl border border-yellow-400/30 bg-yellow-300/10 p-3 sm:gap-4">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-yellow-600/90 dark:text-yellow-400/80">
                    Included in your next message’s context
                  </p>
                  {contextTurns.map(renderBubble)}
                </div>
              )}
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
        <Composer disabled={sending} onSend={(m) => void sendMessage(m)} />
      </div>
    </div>
  );
}
