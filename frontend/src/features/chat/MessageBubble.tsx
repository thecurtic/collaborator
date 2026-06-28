import { Loader2, Square, Trash2, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSpeech } from '@/features/voice/SpeechContext';
import { cn, parseApiDate } from '@/lib/utils';
import type { Turn } from '@/domain/models';

interface MessageBubbleProps {
  turn: Turn;
  onDiscard: (turnId: number) => void;
}

export function MessageBubble({ turn, onDiscard }: MessageBubbleProps) {
  const isUser = turn.role === 'user';
  const text = isUser ? turn.message : turn.response;

  const speech = useSpeech();
  const isActive = speech.activeId === turn.id;
  const ttsLoading = isActive && speech.status === 'preparing';
  const ttsPlaying = isActive && speech.status === 'speaking';
  const canSpeak = !isUser && !!text && turn.id > 0 && speech.supported;

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed sm:max-w-[80%] sm:text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'border border-border bg-card text-card-foreground',
          // Discarded turns stay visible but clearly de-emphasized (dropped from
          // model context but not deleted — see api-spec/API-SPEC.md).
          !turn.committed && 'opacity-40 line-through decoration-1',
        )}
      >
        {text ? (
          <p className="whitespace-pre-wrap break-words">{text}</p>
        ) : (
          // Empty assistant bubble = waiting for the first streamed token.
          <span
            className="flex gap-1 py-1"
            role="status"
            aria-label="Assistant is responding"
          >
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-50" />
          </span>
        )}

        {text && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] opacity-60">
            <span>{parseApiDate(turn.createdAt).toLocaleTimeString()}</span>
          {turn.tokenCount != null && <span>· {turn.tokenCount} tok</span>}
          {turn.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-accent px-1.5 py-0.5 text-accent-foreground"
            >
              {tag}
            </span>
          ))}
          <span className="ml-auto flex items-center gap-1">
            {canSpeak && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={ttsPlaying ? 'Stop reading' : 'Read aloud'}
                title="Read aloud"
                onClick={() => speech.toggle(turn.id, text)}
                className="-my-1 h-7 w-7 opacity-70 hover:opacity-100"
              >
                {ttsLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : ttsPlaying ? (
                  <Square className="h-3.5 w-3.5" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
            {ttsLoading && speech.status === 'preparing' && (
              <span>{Math.round(speech.progress * 100)}%</span>
            )}
            {turn.committed && turn.id > 0 && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Discard from context"
                title="Discard from context"
                onClick={() => onDiscard(turn.id)}
                className="-my-1 h-7 w-7 opacity-70 hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </span>
          </div>
        )}
      </div>
    </div>
  );
}
