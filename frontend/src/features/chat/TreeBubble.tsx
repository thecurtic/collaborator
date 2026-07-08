import {
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Loader2,
  Reply,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { useSpeech } from '@/features/voice/SpeechContext';
import { splitParagraphs } from '@/features/voice/speechUtils';
import { cn } from '@/lib/utils';
import type { TreeNode } from '@/domain/models';

/** Describes the fork at this node: which child paragraph is active + switcher. */
export interface Fork {
  paragraphIndex: number | null;
  /** Displayed numerator: 0 = empty "continue here" slot, 1..n = branches. */
  current: number;
  total: number;
  /** The selected branch's own name (nested under the conversation name). */
  name: string | null;
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
  /** Quote this paragraph into the composer (stackable multi-quote replies). */
  onQuote?: (text: string) => void;
  /** When set, this node is a fork — highlight the source paragraph + switcher. */
  fork?: Fork;
  /** False → this turn is outside the next message's context window (lighter). */
  inContext?: boolean;
}

/**
 * User message text with quote-reply lines ("> …") rendered as styled quotes,
 * so multi-quote replies read as threads instead of raw markdown.
 */
export function UserText({ text }: { text: string }) {
  return (
    <div className="space-y-0.5">
      {text.split('\n').map((line, i) =>
        line.startsWith('> ') || line === '>' ? (
          <p
            key={i}
            className="whitespace-pre-wrap break-words border-l-2 border-primary-foreground/40 pl-2 text-[13px] italic opacity-85"
          >
            {line.replace(/^> ?/, '')}
          </p>
        ) : line ? (
          <p key={i} className="whitespace-pre-wrap break-words">
            {line}
          </p>
        ) : (
          <div key={i} className="h-2" />
        ),
      )}
    </div>
  );
}

function Switcher({
  current,
  total,
  name,
  onPrev,
  onNext,
}: Omit<Fork, 'paragraphIndex'>) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-xl border border-border bg-background px-1.5 py-1 text-[13px] font-medium text-foreground shadow-sm">
      <GitBranch className="mx-0.5 h-4 w-4 shrink-0 text-primary" />
      <button
        type="button"
        aria-label="Previous branch"
        onClick={onPrev}
        className="shrink-0 rounded-md p-1.5 hover:text-primary active:scale-90"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <span className="min-w-[2.4rem] shrink-0 text-center tabular-nums">
        {current} / {total}
      </span>
      {name && (
        <span className="max-w-[9rem] truncate text-muted-foreground">
          {name}
        </span>
      )}
      <button
        type="button"
        aria-label="Next branch"
        onClick={onNext}
        className="shrink-0 rounded-md p-1.5 hover:text-primary active:scale-90"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </span>
  );
}

export function TreeBubble({
  node,
  onBranch,
  onDelete,
  onQuote,
  fork,
  inContext = true,
}: TreeBubbleProps) {
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
          <div className={cn('space-y-1.5', !inContext && 'opacity-60')}>
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
          <div className={cn('space-y-1.5', !inContext && 'opacity-60')}>
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
                  {isUser ? (
                    <div className="min-w-0 flex-1">
                      <UserText text={block} />
                    </div>
                  ) : (
                    <Markdown className="min-w-0 flex-1">{block}</Markdown>
                  )}
                  <span className="flex shrink-0 flex-col">
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
                      className="mt-0.5 rounded p-2 opacity-50 transition hover:opacity-100 active:scale-90"
                    >
                      <GitBranch className="h-4 w-4" />
                    </button>
                    {!isUser && onQuote && (
                      <button
                        type="button"
                        aria-label="Reply to this paragraph"
                        title="Quote this paragraph in your reply"
                        onClick={() => onQuote(block)}
                        className="rounded p-2 opacity-50 transition hover:opacity-100 active:scale-90"
                      >
                        <Reply className="h-4 w-4" />
                      </button>
                    )}
                  </span>
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
              current={fork.current}
              total={fork.total}
              name={fork.name}
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
