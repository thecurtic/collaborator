import { GitBranch, Loader2, Mic, SendHorizontal, Square, X } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { useDictation } from '@/features/voice/useDictation';
import { useWakeLock } from '@/features/voice/useWakeLock';

interface ComposerProps {
  disabled: boolean;
  /** Resolves false if the send failed — the draft is then restored. */
  onSend: (message: string) => Promise<boolean>;
  /** Abort the in-flight response stream (shown as a stop button). */
  onStop?: () => void;
  /** When set, the next send branches from this point (shown as a chip). */
  branchLabel?: string | null;
  onCancelBranch?: () => void;
}

const MAX_TEXTAREA_PX = 160; // matches max-h-40

export function Composer({
  disabled,
  onSend,
  onStop,
  branchLabel = null,
  onCancelBranch,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  // Streaming dictation: transcribes WHILE you speak (live partial below the
  // input), so the final text lands near-instantly when you tap stop.
  const {
    status: dictation,
    partial,
    error: dictationError,
    supported,
    start,
    stop,
  } = useDictation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const recording = dictation === 'listening';
  const busyMic = dictation === 'starting' || dictation === 'finishing';
  useWakeLock(dictation !== 'idle'); // keep screen on while capturing

  // Grow with the content (up to max-h-40), shrink when cleared.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [value]);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    // Clear optimistically (the streaming bubble shows the text); restore the
    // draft if the send fails so the message isn't lost.
    setValue('');
    const ok = await onSend(trimmed);
    if (!ok) setValue((v) => (v ? v : trimmed));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  async function handleMic() {
    setVoiceNotice(null);
    if (recording) {
      const text = await stop();
      if (text) setValue((v) => (v ? `${v.trimEnd()} ${text}` : text));
      else setVoiceNotice('Didn’t catch anything — try again.');
    } else {
      await start();
    }
  }

  const error = dictationError ?? voiceNotice;

  return (
    <div className="px-safe pb-safe border-t border-border bg-background">
      {branchLabel && (
        <div className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            Branching from: <span className="text-foreground">{branchLabel}</span>
          </span>
          <button
            type="button"
            aria-label="Cancel branch"
            onClick={onCancelBranch}
            className="shrink-0 rounded p-0.5 hover:text-foreground active:scale-90"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {error && (
        <p className="px-4 pt-2 text-xs text-destructive">{error}</p>
      )}
      {(recording || dictation === 'starting') && (
        <p className="flex items-start gap-2 px-4 pt-2 text-xs text-muted-foreground">
          <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-destructive" />
          <span className="line-clamp-2 min-w-0">
            {partial ||
              (recording
                ? 'Listening… tap the stop button when you’re done.'
                : 'Connecting…')}
          </span>
        </p>
      )}
      <form onSubmit={handleSubmit} className="flex items-end gap-2 p-3 sm:p-4">
        {supported && (
          <Button
            type="button"
            variant={recording ? 'destructive' : 'ghost'}
            size="icon"
            onClick={() => void handleMic()}
            disabled={disabled || busyMic}
            aria-label={recording ? 'Stop dictation' : 'Dictate'}
            title={recording ? 'Stop dictation' : 'Dictate'}
            className="h-11 w-11 shrink-0 rounded-xl sm:h-10 sm:w-10 sm:rounded-md"
          >
            {busyMic ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : recording ? (
              <Square className="h-4 w-4" />
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </Button>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={
            dictation === 'finishing' ? 'Transcribing…' : 'Message Collaborator…'
          }
          // text-base (16px) on mobile prevents iOS from auto-zooming on focus.
          className="max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-input bg-card px-3.5 py-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:rounded-md sm:py-2.5 sm:text-sm"
        />
        {disabled && onStop ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={onStop}
            aria-label="Stop generating"
            title="Stop generating"
            className="h-11 w-11 shrink-0 rounded-xl sm:h-10 sm:w-10 sm:rounded-md"
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            className="h-11 w-11 shrink-0 rounded-xl sm:h-10 sm:w-10 sm:rounded-md"
          >
            <SendHorizontal className="h-5 w-5 sm:h-4 sm:w-4" />
          </Button>
        )}
      </form>
    </div>
  );
}
