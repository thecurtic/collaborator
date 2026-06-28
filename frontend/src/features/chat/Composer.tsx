import { Loader2, Mic, SendHorizontal, Square } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import { useRecorder } from '@/features/voice/useRecorder';

interface ComposerProps {
  disabled: boolean;
  onSend: (message: string) => void;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [value, setValue] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const { status: recStatus, error: recError, supported, start, stop } =
    useRecorder();

  const recording = recStatus === 'recording';

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

  async function handleMic() {
    setVoiceError(null);
    if (recording) {
      const result = await stop();
      if (!result) return;
      setTranscribing(true);
      try {
        const text = (await api.transcribe(result.blob, {
          filename: result.filename,
        })).trim();
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
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={transcribing ? 'Transcribing…' : 'Message Collaborator…'}
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
    </div>
  );
}
