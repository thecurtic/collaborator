import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, parseApiDate } from '@/lib/utils';
import type { Turn } from '@/domain/models';

interface MessageBubbleProps {
  turn: Turn;
  onDiscard: (turnId: number) => void;
}

export function MessageBubble({ turn, onDiscard }: MessageBubbleProps) {
  const isUser = turn.role === 'user';
  const text = isUser ? turn.message : turn.response;

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
        <p className="whitespace-pre-wrap break-words">{text}</p>

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
          {turn.committed && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Discard from context"
              title="Discard from context"
              onClick={() => onDiscard(turn.id)}
              // Always visible (works on touch); sits inline in the meta row.
              className="-my-1 ml-auto h-7 w-7 opacity-70 hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
