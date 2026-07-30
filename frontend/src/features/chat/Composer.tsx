import {
  GitBranch,
  Loader2,
  Mic,
  Phone,
  Plus,
  SendHorizontal,
  Square,
  X,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { useDictation } from '@/features/voice/useDictation';
import { useWakeLock } from '@/features/voice/useWakeLock';
import { useLongPress } from '@/lib/useLongPress';
import { cleanUrlsInText } from '@/lib/urlClean';
import { appendQuoteToDraft } from './quote';

/** Imperative surface for quote-replies and edit-and-resend prefills. */
export interface ComposerHandle {
  /** Append a quote block to the draft, leaving the cursor area below it. */
  appendQuote: (quote: string) => void;
  /** Replace the draft (regenerate / edit-and-resend prefill). */
  setDraft: (text: string) => void;
}

interface ComposerProps {
  disabled: boolean;
  /**
   * Resolves false if the send failed OR was stopped mid-response — the
   * draft is then restored for tweak-and-resend.
   */
  onSend: (message: string) => Promise<boolean>;
  /** Abort the in-flight response stream (shown as a stop button). */
  onStop?: () => void;
  /**
   * Start a voice call (the call button lives here, not the header). Any
   * current draft is passed along — it becomes the call's first turn, so the
   * field is cleared like a send.
   */
  onStartCall?: (draft?: string) => void;
  /** When set, the next send branches from this point (shown as a chip). */
  branchLabel?: string | null;
  onCancelBranch?: () => void;
  ref?: Ref<ComposerHandle>;
}

const MAX_TEXTAREA_PX = 160; // matches max-h-40

export function Composer({
  disabled,
  onSend,
  onStop,
  onStartCall,
  branchLabel = null,
  onCancelBranch,
  ref,
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

  // Quote-replies: paragraph Reply buttons stack quotes into the draft.
  // Deliberately no focus() — the keyboard would cover the paragraphs the
  // user may still want to quote.
  useImperativeHandle(
    ref,
    () => ({
      appendQuote: (quote: string) =>
        setValue((v) => appendQuoteToDraft(v, quote)),
      setDraft: (text: string) => setValue(text),
    }),
    [],
  );

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

  // Pasted links get their tracking params stripped at the door, so the
  // cleaned URL is what the user sees, sends, and stores.
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const raw = e.clipboardData.getData('text/plain');
    if (!raw || !/https?:\/\//i.test(raw)) return;
    const cleaned = cleanUrlsInText(raw);
    if (cleaned === raw) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    setValue((v) => v.slice(0, start) + cleaned + v.slice(end));
    requestAnimationFrame(() => {
      const caret = start + cleaned.length;
      el.setSelectionRange(caret, caret);
    });
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
  const hasDraft = value.trim().length > 0;

  // Hold send → the draft becomes a call's opening turn (the call button is
  // hidden while a draft exists, so the hold IS the entry point). A normal
  // tap falls through to the form submit; useLongPress swallows the click
  // that follows a hold, so holding never also sends.
  const sendHold = useLongPress(() => {
    const draft = value.trim();
    if (!draft || disabled || !onStartCall) return;
    setValue('');
    onStartCall(draft);
  });

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
      {/* One visual box, two layers: text on top, buttons below. Extra bottom
          padding lifts the whole thing off the phone's bottom edge. */}
      <form onSubmit={handleSubmit} className="px-3 pb-5 pt-3 sm:px-4">
        <div className="rounded-2xl border border-input bg-card px-3 pb-2 pt-2.5 focus-within:ring-2 focus-within:ring-ring">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            placeholder={
              dictation === 'finishing'
                ? 'Transcribing…'
                : 'Message Collaborator…'
            }
            // text-base (16px) on mobile prevents iOS from auto-zooming on focus.
            className="max-h-40 min-h-[2.25rem] w-full resize-none border-0 bg-transparent px-1 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
          />
          <div className="mt-1 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled
              aria-label="Add attachment (coming soon)"
              title="Attachments — coming soon"
              className="h-9 w-9 rounded-full text-muted-foreground"
            >
              <Plus className="h-5 w-5" />
            </Button>
            <span className="ml-auto flex items-center gap-1">
              {supported && (
                <Button
                  type="button"
                  variant={recording ? 'destructive' : 'ghost'}
                  size="icon"
                  onClick={() => void handleMic()}
                  disabled={disabled || busyMic}
                  aria-label={recording ? 'Stop dictation' : 'Dictate'}
                  title={recording ? 'Stop dictation' : 'Dictate'}
                  className="h-9 w-9 rounded-full"
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
              {/* Rightmost: call normally; morphs into send once there's a
                  draft; stop while a response is streaming. */}
              {disabled && onStop ? (
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  onClick={onStop}
                  aria-label="Stop generating"
                  title="Stop generating"
                  className="h-9 w-9 rounded-full"
                >
                  <Square className="h-4 w-4" />
                </Button>
              ) : hasDraft ? (
                <Button
                  type="submit"
                  size="icon"
                  disabled={disabled}
                  {...(onStartCall ? sendHold : {})}
                  aria-label="Send message (hold to continue in a call)"
                  title="Send · hold to talk it out in a call instead"
                  className="h-9 w-9 select-none rounded-full"
                >
                  <SendHorizontal className="h-4 w-4" />
                </Button>
              ) : (
                onStartCall && (
                  <Button
                    type="button"
                    size="icon"
                    onClick={() => onStartCall(undefined)}
                    disabled={disabled}
                    aria-label="Start voice call"
                    title="Start voice call"
                    className="h-9 w-9 rounded-full"
                  >
                    <Phone className="h-4 w-4" />
                  </Button>
                )
              )}
            </span>
          </div>
        </div>
      </form>
    </div>
  );
}
