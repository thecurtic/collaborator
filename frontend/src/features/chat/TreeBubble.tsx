import { GitBranch, Loader2, Square, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSpeech } from '@/features/voice/SpeechContext';
import { cn } from '@/lib/utils';
import type { TreeNode } from '@/domain/models';

interface TreeBubbleProps {
  node: TreeNode;
  onBranch: (turnId: number, paragraphIndex: number | undefined, label: string) => void;
}

export function TreeBubble({ node, onBranch }: TreeBubbleProps) {
  const isUser = node.role === 'user';
  const speech = useSpeech();
  const isActive = speech.activeId === node.id;
  const ttsLoading = isActive && speech.status === 'preparing';
  const ttsPlaying = isActive && speech.status === 'speaking';
  const canSpeak = !isUser && !!node.content && speech.supported;

  // Per-paragraph branch affordances only when an assistant turn has >1 paragraph.
  const paragraphs =
    !isUser && node.paragraphs.length > 1 ? node.paragraphs : null;

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
        {paragraphs ? (
          <div className="space-y-2">
            {paragraphs.map((p, i) => (
              <div key={i} className="flex items-start gap-1">
                <p className="flex-1 whitespace-pre-wrap break-words">{p}</p>
                <button
                  type="button"
                  aria-label="Branch from this paragraph"
                  title="Branch from this paragraph"
                  onClick={() => onBranch(node.id, i, p)}
                  className="mt-0.5 shrink-0 rounded p-1 opacity-40 transition hover:opacity-100 active:scale-90"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">{node.content}</p>
        )}

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
              aria-label="Branch from this turn"
              title="Branch from this turn"
              onClick={() => onBranch(node.id, undefined, node.preview)}
              className="-my-1 h-7 w-7 opacity-70 hover:opacity-100"
            >
              <GitBranch className="h-3.5 w-3.5" />
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
