import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { useChat } from './useChat';

export function ChatView() {
  const { turns, loading, sending, error, sendMessage, discardTurn } =
    useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns.length, sending]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
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
            turns.map((turn) => (
              <MessageBubble
                key={turn.id}
                turn={turn}
                onDiscard={discardTurn}
              />
            ))
          )}

          {sending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Collaborator is thinking…
            </div>
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
