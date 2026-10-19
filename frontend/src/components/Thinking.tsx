import { Brain } from 'lucide-react';

/**
 * The model's reasoning for a reply (UX doc, Voice; the same in typed
 * chats): full height and readable, streaming in place of the reply until
 * the reply starts, then kept above it ("Thought") until the next turn.
 * Never spoken, never saved.
 */
export function Thinking({ text, done }: { text: string; done: boolean }) {
  return (
    <div className="mb-2 rounded-lg border border-dashed border-border bg-muted/30 px-3.5 py-3">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Brain className="h-3.5 w-3.5 shrink-0" />
        {done ? 'Thought' : 'Thinking'}
      </p>
      <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-muted-foreground">
        {text}
      </p>
    </div>
  );
}
