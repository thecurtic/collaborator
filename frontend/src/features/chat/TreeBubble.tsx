import {
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Loader2,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSpeech } from '@/features/voice/SpeechContext';
import { cn } from '@/lib/utils';
import type { TreeNode } from '@/domain/models';

/** Describes the fork at this node: which child paragraph is active + switcher. */
export interface Fork {
  paragraphIndex: number | null;
  index: number; // 0-based active sibling
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

interface TreeBubbleProps {
  node: TreeNode;
  onBranch: (
    turnId: number,
    paragraphIndex: number | undefined,
    label: string,
  ) => void;
  onDelete: (turnId: number) => void;
  /** When set, this node is a fork — highlight the source paragraph + switcher. */
  fork?: Fork;
}

function Switcher({ index, total, onPrev, onNext }: Omit<Fork, 'paragraphIndex'>) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
      <button
        type="button"
        aria-label="Previous branch"
        onClick={onPrev}
        className="active:scale-90"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      {index + 1}/{total}
      <button
        type="button"
        aria-label="Next branch"
        onClick={onNext}
        className="active:scale-90"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

export function TreeBubble({ node, onBranch, onDelete, fork }: TreeBubbleProps) {
  const isUser = node.role === 'user';
  const speech = useSpeech();
  const isActive = speech.activeId === node.id;
  const ttsLoading = isActive && speech.status === 'preparing';
  const ttsPlaying = isActive && speech.status === 'speaking';
  const canSpeak = !isUser && !!node.content && speech.supported;

  const multiPara = !isUser && node.paragraphs.length > 1;
  const blocks = multiPara ? node.paragraphs : [node.content];

  // Which block is the fork's source paragraph (highlighted).
  const forkBlock = (i: number) => {
    if (!fork) return false;
    if (fork.paragraphIndex != null) return fork.paragraphIndex === i;
    return blocks.length === 1 && i === 0; // turn-level fork → highlight the block
  };

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed sm:max-w-[80%] sm:text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'border border-border bg-card text-card-foreground',
        )}
      >
        <div className="space-y-1.5">
          {blocks.map((block, i) => {
            const highlighted = forkBlock(i);
            return (
              <div key={i}>
                <div
                  className={cn(
                    'flex items-start gap-1 rounded',
                    highlighted &&
                      'bg-primary/10 px-2 py-1 ring-1 ring-primary/30',
                  )}
                >
                  <p className="flex-1 whitespace-pre-wrap break-words">
                    {block}
                  </p>
                  <button
                    type="button"
                    aria-label="Branch from here"
                    title="Branch from here"
                    onClick={() =>
                      onBranch(
                        node.id,
                        multiPara ? i : undefined,
                        multiPara ? block : node.preview,
                      )
                    }
                    className="mt-0.5 shrink-0 rounded p-1 opacity-40 transition hover:opacity-100 active:scale-90"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                  </button>
                </div>
                {highlighted && fork && (
                  <Switcher
                    index={fork.index}
                    total={fork.total}
                    onPrev={fork.onPrev}
                    onNext={fork.onNext}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-1.5 flex items-center gap-1 text-[10px] opacity-60">
          {node.paragraphIndex != null && <span>branched</span>}
          <span className="ml-auto flex items-center gap-1">
            {canSpeak && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={ttsPlaying ? 'Stop reading' : 'Read aloud'}
                onClick={() => speech.toggle(node.id, node.content)}
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
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete this turn"
              title="Delete this turn"
              onClick={() => onDelete(node.id)}
              className="-my-1 h-7 w-7 opacity-70 hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
