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
import { splitParagraphs } from '@/features/voice/speechUtils';
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
    <span className="inline-flex items-center gap-1 rounded-xl border border-border bg-background px-1.5 py-1 text-[13px] font-medium text-foreground shadow-sm">
      <GitBranch className="mx-0.5 h-4 w-4 text-primary" />
      <button
        type="button"
        aria-label="Previous branch"
        onClick={onPrev}
        className="rounded-md p-1.5 hover:text-primary active:scale-90"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <span className="min-w-[2.4rem] text-center tabular-nums">
        {index + 1} / {total}
      </span>
      <button
        type="button"
        aria-label="Next branch"
        onClick={onNext}
        className="rounded-md p-1.5 hover:text-primary active:scale-90"
      >
        <ChevronRight className="h-5 w-5" />
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

  // Read-along: while this turn is being spoken, fade the not-yet-read text.
  const reading = isActive;
  const readChars = Math.min(
    speech.speakBase + speech.spokenChars,
    node.content.length,
  );

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
        {reading ? (
          <div className="space-y-1.5">
            {splitParagraphs(node.content).map(({ text: p, start }, i) =>
              p.trim() ? (
                <p
                  key={i}
                  onClick={() => speech.speakFrom(node.id, node.content, i)}
                  title="Tap to play from here"
                  className="cursor-pointer whitespace-pre-wrap break-words active:opacity-70"
                >
                  {(() => {
                    const n = Math.min(Math.max(readChars - start, 0), p.length);
                    return (
                      <>
                        <span>{p.slice(0, n)}</span>
                        {n < p.length && (
                          <span className="opacity-40">{p.slice(n)}</span>
                        )}
                      </>
                    );
                  })()}
                </p>
              ) : null,
            )}
          </div>
        ) : (
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
                    className="mt-0.5 shrink-0 rounded p-2 opacity-50 transition hover:opacity-100 active:scale-90"
                  >
                    <GitBranch className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
          </div>
        )}

        {/* Persistent branch switcher — one per fork-turn, always visible. */}
        {fork && (
          <div className="mt-2 flex">
            <Switcher
              index={fork.index}
              total={fork.total}
              onPrev={fork.onPrev}
              onNext={fork.onNext}
            />
          </div>
        )}

        <div className="mt-1.5 flex items-center gap-2 text-[10px] opacity-60">
          {node.paragraphIndex != null && <span>branched</span>}
          <span className="ml-auto flex items-center gap-2">
            {canSpeak && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={ttsPlaying ? 'Stop reading' : 'Read aloud'}
                onClick={() => speech.toggle(node.id, node.content)}
                className="-my-1 h-9 w-9 opacity-70 hover:opacity-100"
              >
                {ttsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : ttsPlaying ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete this turn"
              title="Delete this turn"
              onClick={() => onDelete(node.id)}
              className="-my-1 h-9 w-9 opacity-70 hover:opacity-100"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
