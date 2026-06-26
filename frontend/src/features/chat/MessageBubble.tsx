import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Turn } from '@/domain/models';

interface MessageBubbleProps {
  turn: Turn;
  onDiscard: (turnId: number) => void;
}

export function MessageBubble({ turn, onDiscard }: MessageBubbleProps) {
  const isUser = turn.role === 'user';
  const text = isUser ? turn.message : turn.response;

  return (
    <div
      className={cn(
        'group flex w-full',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={cn(
          'relative max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-card text-card-foreground border border-border',
          // Discarded turns stay visible but clearly de-emphasized (the turn is
          // dropped from model context but not deleted — see API-SPEC.md).
          !turn.committed && 'opacity-40 line-through decoration-1',
        )}
      >
        <p className="whitespace-pre-wrap break-words">{text}</p>

        <div className="mt-1 flex items-center gap-2 text-[10px] opacity-60">
          <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
          {turn.tokenCount != null && <span>· {turn.tokenCount} tok</span>}
          {turn.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-accent px-1.5 py-0.5 text-accent-foreground"
            >
              {tag}
            </span>
          ))}
        </div>

        {turn.committed && (
          <Button
            variant="ghost"
            size="icon"
            title="Discard from context"
            onClick={() => onDiscard(turn.id)}
            className={cn(
              'absolute -top-3 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100',
              isUser ? '-left-3' : '-right-3',
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
