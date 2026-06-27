import { SendHorizontal } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { Button } from '@/components/ui/button';

interface ComposerProps {
  disabled: boolean;
  onSend: (message: string) => void;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [value, setValue] = useState('');

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="pb-safe px-safe flex items-end gap-2 border-t border-border bg-background p-3 sm:p-4"
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="Message Collaborator…"
        // text-base (16px) on mobile prevents iOS from auto-zooming on focus.
        className="max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-input bg-card px-3.5 py-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:rounded-md sm:py-2.5 sm:text-sm"
      />
      <Button
        type="submit"
        size="icon"
        disabled={disabled || !value.trim()}
        aria-label="Send message"
        className="h-11 w-11 shrink-0 rounded-xl sm:h-10 sm:w-10 sm:rounded-md"
      >
        <SendHorizontal className="h-5 w-5 sm:h-4 sm:w-4" />
      </Button>
    </form>
  );
}
