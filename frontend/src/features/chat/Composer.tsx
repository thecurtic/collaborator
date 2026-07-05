import { GitBranch, Loader2, Mic, SendHorizontal, Square, X } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { getSttEngine } from '@/features/settings/uiPrefs';
import { transcribeBlobOnDevice } from '@/features/voice/deviceTranscriber';
import { useRecorder } from '@/features/voice/useRecorder';
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
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const { status: recStatus, error: recError, supported, start, stop, cancel } =
    useRecorder();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const recording = recStatus === 'recording';
  useWakeLock(recording || transcribing); // keep screen on while capturing

  // Release the mic if we unmount mid-recording.
  useEffect(() => () => cancel(), [cancel]);

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
    setVoiceError(null);
    if (recording) {
      const result = await stop();
      if (!result) return;
      setTranscribing(true);
      try {
        const text = (
          getSttEngine() === 'device'
            ? await transcribeBlobOnDevice(result.blob)
            : await api.transcribe(result.blob, { filename: result.filename })
        ).trim();
        if (text) setValue((v) => (v ? `${v.trimEnd()} ${text}` : text));
      } catch (err) {
        setVoiceError(
          err instanceof Error ? err.message : 'Transcription failed.',
        );
      } finally {
        setTranscribing(false);
      }
    } else {
      await start();
    }
  }

  const error = voiceError ?? recError;

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
      {recording && (
        <p className="flex items-center gap-2 px-4 pt-2 text-xs text-muted-foreground">
          <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
          Recording… tap the stop button when you’re done.
        </p>
      )}
      <form onSubmit={handleSubmit} className="flex items-end gap-2 p-3 sm:p-4">
        {supported && (
          <Button
            type="button"
            variant={recording ? 'destructive' : 'ghost'}
            size="icon"
            onClick={() => void handleMic()}
            disabled={disabled || transcribing}
            aria-label={recording ? 'Stop recording' : 'Record voice'}
            title={recording ? 'Stop recording' : 'Record voice'}
            className="h-11 w-11 shrink-0 rounded-xl sm:h-10 sm:w-10 sm:rounded-md"
          >
            {transcribing ? (
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
          placeholder={transcribing ? 'Transcribing…' : 'Message Collaborator…'}
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
