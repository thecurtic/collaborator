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
      className="flex items-end gap-2 border-t border-border bg-background p-4"
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="Message Collaborator…  (Enter to send, Shift+Enter for newline)"
        className="max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-md border border-input bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button type="submit" size="icon" disabled={disabled || !value.trim()}>
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </form>
  );
}
