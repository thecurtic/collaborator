import {
  AlertCircle,
  Camera,
  GitBranch,
  Loader2,
  Mic,
  Paperclip,
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
import { ActionSheet } from '@/components/ActionSheet';
import { Button } from '@/components/ui/button';
import type { Attachment } from '@/domain/models';
import { attachmentsApi, formatSize, isMediaFile } from '@/features/attachments/attachmentsApi';
import { kindIcon } from '@/features/attachments/AttachmentViews';
import { CameraSheet } from '@/features/attachments/CameraSheet';
import { useDictation } from '@/features/voice/useDictation';
import { useWakeLock } from '@/features/voice/useWakeLock';
import { useLongPress } from '@/lib/useLongPress';
import { cleanUrlsInText } from '@/lib/urlClean';
import { cn } from '@/lib/utils';
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
   * draft (and its attachments) is then restored for tweak-and-resend.
   * `transcribe`: sent with a hold, so its audio and video get transcribed.
   */
  onSend: (message: string, attachments: Attachment[], transcribe?: boolean) => Promise<boolean>;
  /** Abort the in-flight response stream (shown as a stop button). */
  onStop?: () => void;
  /** A stop was asked for and the reply is winding down. */
  stopping?: boolean;
  /**
   * Start a voice call (the call button lives here, not the header). Any
   * current draft is passed along — it becomes the call's first turn, so the
   * field is cleared like a send — and so are attached files, as a hand-over.
   */
  onStartCall?: (draft?: string, attachments?: Attachment[]) => void;
  /** When set, the next send branches from this point (shown as a chip). */
  branchLabel?: string | null;
  onCancelBranch?: () => void;
  ref?: Ref<ComposerHandle>;
}

const MAX_TEXTAREA_PX = 160; // matches max-h-40
const MAX_ATTACHMENTS = 10; // the backend's per-message limit

/** A file on its way into the next message: uploading, ready, or failed. */
interface PendingFile {
  key: string;
  name: string;
  size: number;
  /** Local preview for images (revoked when the chip goes). */
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'error';
  /** 0–1 while uploading. */
  progress: number;
  /** Audio or video (sending it with a hold transcribes it). */
  media: boolean;
  attachment?: Attachment;
  error?: string;
  abort?: AbortController;
}

let pendingSeq = 0;


export function Composer({
  disabled,
  onSend,
  onStop,
  stopping = false,
  onStartCall,
  branchLabel = null,
  onCancelBranch,
  ref,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  // Attachments upload the moment they're picked (to the server, so every
  // device sees them); the message only carries their ids.
  const [files, setFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [camera, setCamera] = useState(false);
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

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    setFiles((prev) => {
      const room = MAX_ATTACHMENTS - prev.length;
      if (room <= 0) return prev;
      const added: PendingFile[] = incoming.slice(0, room).map((file) => {
        const abort = new AbortController();
        const key = `f${++pendingSeq}`;
        const name = file.name || 'pasted-file';
        void attachmentsApi
          .upload(file, name, abort.signal, (progress) =>
            setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, progress } : f))),
          )
          .then((attachment) =>
            setFiles((cur) =>
              cur.map((f) => (f.key === key ? { ...f, status: 'ready', attachment } : f)),
            ),
          )
          .catch((err: unknown) => {
            if (abort.signal.aborted) return;
            setFiles((cur) =>
              cur.map((f) =>
                f.key === key
                  ? { ...f, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
                  : f,
              ),
            );
          });
        return {
          key,
          name,
          size: file.size,
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
          status: 'uploading',
          progress: 0,
          media: isMediaFile(file.type, name),
          abort,
        };
      });
      return [...prev, ...added];
    });
  }

  function removeFile(key: string) {
    setFiles((cur) => {
      const f = cur.find((x) => x.key === key);
      if (f) {
        f.abort?.abort();
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
        // Never sent: discard it server-side too (best-effort).
        if (f.attachment) void attachmentsApi.remove(f.attachment.id).catch(() => {});
      }
      return cur.filter((x) => x.key !== key);
    });
  }

  const uploading = files.some((f) => f.status === 'uploading');
  const ready = files.filter((f) => f.status === 'ready' && f.attachment);

  async function submit(transcribe = false) {
    const trimmed = value.trim();
    if ((!trimmed && ready.length === 0) || disabled || uploading) return;
    // Clear optimistically (the streaming bubble shows the text); restore the
    // draft if the send fails so the message isn't lost.
    const sentFiles = files;
    setValue('');
    setFiles([]);
    const ok = await onSend(
      trimmed,
      ready.map((f) => f.attachment as Attachment),
      transcribe,
    );
    if (!ok) {
      setValue((v) => (v ? v : trimmed));
      setFiles((cur) => (cur.length ? cur : sentFiles));
    } else {
      sentFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    }
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
    // Pasted files (a screenshot, a copied image) become attachments.
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
      return;
    }
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
  const hasDraft = value.trim().length > 0 || files.length > 0;
  const hasMedia = files.some((f) => f.media);

  // Hold send → the draft becomes a call's opening turn (the call button is
  // hidden while a draft exists, so the hold IS the entry point). With a
  // recording or video attached, the hold means "transcribe it" instead
  // (as holding send does in Scratch); a tap sends it untranscribed. A
  // normal tap falls through to the form submit; useLongPress swallows the
  // click that follows a hold, so holding never also sends.
  const sendHold = useLongPress(() => {
    if (hasMedia) {
      void submit(true);
      return;
    }
    const draft = value.trim();
    // Files go along as a hand-over; wait for them to finish uploading.
    if ((!draft && ready.length === 0) || disabled || !onStartCall || uploading)
      return;
    const sentFiles = files;
    setValue('');
    setFiles([]);
    sentFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    onStartCall(
      draft,
      ready.map((f) => f.attachment as Attachment),
    );
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
      <form
        onSubmit={handleSubmit}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }
        }}
        className="px-3 pb-5 pt-3 sm:px-4"
      >
        <div className="rounded-2xl border border-input bg-card px-3 pb-2 pt-2.5 focus-within:ring-2 focus-within:ring-ring">
          {files.length > 0 && (
            <div className="mb-1.5 flex gap-1.5 overflow-x-auto pb-1">
              {files.map((f) => {
                const Icon = kindIcon(f.attachment?.kind ?? 'file');
                return (
                  <div
                    key={f.key}
                    className={cn(
                      'relative flex shrink-0 items-center gap-1.5 rounded-lg border bg-muted/60 text-xs',
                      f.previewUrl ? 'p-0' : 'max-w-[15rem] py-1.5 pl-2 pr-7',
                      f.status === 'error' ? 'border-destructive/60' : 'border-border',
                    )}
                    title={f.error ?? f.name}
                  >
                    {f.previewUrl ? (
                      <img src={f.previewUrl} alt={f.name} className="h-14 w-14 rounded-lg object-cover" />
                    ) : (
                      <>
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground">{f.name}</span>
                          <span
                            className={cn(
                              'block',
                              f.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
                            )}
                          >
                            {f.status === 'error'
                              ? (f.error ?? 'Upload failed')
                              : f.status === 'uploading' && f.size > 2_000_000
                                ? `${Math.round(f.progress * 100)}% of ${formatSize(f.size)}`
                                : formatSize(f.size)}
                          </span>
                        </span>
                      </>
                    )}
                    {f.status === 'uploading' && (f.previewUrl || f.size <= 2_000_000) && (
                      <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/50">
                        <Loader2 className="h-4 w-4 animate-spin text-foreground" />
                      </span>
                    )}
                    {f.status === 'error' && f.previewUrl && (
                      <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                        <AlertCircle className="h-4 w-4 text-destructive" />
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => removeFile(f.key)}
                      className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-foreground shadow-sm active:scale-90"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {hasMedia && (
            <p className="mb-1 px-1 text-[11px] text-muted-foreground">
              Tap send to send it as is · hold send to transcribe it
            </p>
          )}
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
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = ''; // the same file can be picked again
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={files.length >= MAX_ATTACHMENTS}
              onClick={() => setAddMenu(true)}
              aria-label="Add photos or files"
              title="Camera, photos or files"
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
                  disabled={stopping}
                  aria-label={stopping ? 'Stopping' : 'Stop generating'}
                  title={stopping ? 'Stopping' : 'Stop generating'}
                  className="h-9 w-9 rounded-full"
                >
                  {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                </Button>
              ) : hasDraft ? (
                <Button
                  type="submit"
                  size="icon"
                  disabled={disabled || uploading}
                  {...(onStartCall || hasMedia ? sendHold : {})}
                  aria-label={
                    hasMedia
                      ? 'Send (hold to transcribe the recording)'
                      : 'Send message (hold to continue in a call)'
                  }
                  title={
                    hasMedia
                      ? 'Tap: send the file as is · Hold: transcribe it'
                      : 'Send · hold to talk it out in a call instead'
                  }
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
      <ActionSheet
        open={addMenu}
        actions={[
          { label: 'Camera', icon: Camera, onSelect: () => setCamera(true) },
          {
            label: 'Photos and files',
            icon: Paperclip,
            onSelect: () => fileInputRef.current?.click(),
          },
        ]}
        onClose={() => setAddMenu(false)}
      />
      <CameraSheet open={camera} onClose={() => setCamera(false)} onDone={addFiles} />
    </div>
  );
}
