import {
  Download,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  RefreshCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import type { Attachment, AttachmentKind, TurnAttachment } from '@/domain/models';
import { useModalA11y } from '@/lib/useModalA11y';
import { cn } from '@/lib/utils';
import { attachmentUrl, attachmentsApi, formatSize } from './attachmentsApi';

const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  document: FileText,
  text: FileText,
  audio: FileAudio,
  video: FileVideo,
  file: File,
};

export function kindIcon(kind: AttachmentKind): LucideIcon {
  return KIND_ICON[kind] ?? File;
}

/** An image attachment's thumbnail, fetched through the authed HTTP layer. */
export function AttachmentImage({
  id,
  alt,
  className,
}: {
  id: number;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    attachmentUrl(id)
      .then((u) => live && setUrl(u))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id]);
  if (failed) {
    return (
      <span className={cn('flex items-center justify-center bg-muted', className)}>
        <FileImage className="h-5 w-5 text-muted-foreground" />
      </span>
    );
  }
  if (!url) return <span className={cn('block animate-pulse bg-muted', className)} />;
  return <img src={url} alt={alt} className={cn('object-cover', className)} />;
}

/**
 * The files a sent message carried, shown on its bubble: images as
 * thumbnails, everything else as a chip. Tapping one opens what
 * Collaborator read from it.
 */
export function AttachmentStrip({
  items,
  onPrimary = false,
}: {
  items: TurnAttachment[];
  /** On the user's (primary-colored) bubble. */
  onPrimary?: boolean;
}) {
  const [open, setOpen] = useState<TurnAttachment | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {items.map((a) =>
          a.kind === 'image' ? (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(a)}
              aria-label={`Open ${a.filename}`}
              className="overflow-hidden rounded-lg ring-1 ring-black/10 active:opacity-80"
            >
              <AttachmentImage id={a.id} alt={a.filename} className="h-20 w-20" />
            </button>
          ) : (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(a)}
              className={cn(
                'flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs active:opacity-80',
                onPrimary ? 'bg-primary-foreground/15' : 'bg-muted',
              )}
            >
              {(() => {
                const Icon = kindIcon(a.kind);
                return <Icon className="h-4 w-4 shrink-0 opacity-80" />;
              })()}
              <span className="min-w-0">
                <span className="block max-w-[12rem] truncate font-medium">{a.filename}</span>
                <span className="block opacity-70">{formatSize(a.size)}</span>
              </span>
            </button>
          ),
        )}
      </div>
      <AttachmentSheet item={open} onClose={() => setOpen(null)} />
    </>
  );
}

const MEDIA = new Set(['audio', 'video']);

function statusLine(a: Attachment): string {
  switch (a.textStatus) {
    case 'pending':
    case 'working':
      return MEDIA.has(a.kind) ? 'Being transcribed…' : 'Being read…';
    case 'idle':
      return 'Not transcribed.';
    case 'failed':
      return `Couldn’t be read: ${a.textError ?? 'unknown error'}`;
    case 'none':
      return a.kind === 'image'
        ? 'Not read: no model here reads images yet.'
        : 'Nothing to read in this kind of file.';
    default:
      return a.textVia === 'vision'
        ? 'Read by the model (text and a description):'
        : a.textVia === 'pdf-text+vision'
          ? 'Text layer, plus scanned pages read by the model:'
          : a.textVia === 'speech-to-text'
            ? 'Transcribed:'
            : 'What Collaborator read:';
  }
}

/** One attachment: a preview, what was read from it, and the file itself. */
export function AttachmentSheet({
  item,
  onClose,
}: {
  item: TurnAttachment | null;
  onClose: () => void;
}) {
  const open = item != null;
  const panelRef = useModalA11y<HTMLDivElement>(open, onClose);
  const [detail, setDetail] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    let live = true;
    setDetail(null);
    setError(null);
    setFileUrl(null);
    const load = () =>
      attachmentsApi
        .get(item.id)
        .then((a) => {
          if (!live) return;
          setDetail(a);
          // Still being read: look again shortly.
          if (a.textStatus === 'pending' || a.textStatus === 'working') {
            setTimeout(() => live && void load(), 2000);
          }
        })
        .catch((err: unknown) => live && setError(err instanceof Error ? err.message : 'Could not load'));
    void load();
    attachmentUrl(item.id)
      .then((u) => live && setFileUrl(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [item]);

  if (!item) return null;

  const retry = () => {
    attachmentsApi
      .extract(item.id)
      .then((a) => {
        setDetail(a);
        const poll = () =>
          attachmentsApi.get(item.id).then((d) => {
            setDetail(d);
            if (d.textStatus === 'pending' || d.textStatus === 'working') {
              setTimeout(() => void poll(), 2000);
            }
          });
        setTimeout(() => void poll(), 1500);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not retry'));
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={item.filename}
        tabIndex={-1}
        className="pb-safe relative flex max-h-[88vh] w-full flex-col rounded-t-2xl border border-border bg-card p-4 outline-none sm:max-w-lg sm:rounded-2xl"
      >
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="break-words text-base font-semibold">{item.filename}</p>
            <p className="text-xs text-muted-foreground">
              {[
                item.kind,
                formatSize(item.size),
                detail?.pages ? `${detail.pages} pages` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 -mt-1 h-8 w-8 shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {item.kind === 'image' && fileUrl && (
            <img
              src={fileUrl}
              alt={item.filename}
              className="mb-3 max-h-[45vh] w-full rounded-lg bg-muted object-contain"
            />
          )}
          {item.kind === 'audio' && fileUrl && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio src={fileUrl} controls className="mb-3 w-full" />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!detail && !error && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          )}
          {detail && (
            <>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                {(detail.textStatus === 'pending' || detail.textStatus === 'working') && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {statusLine(detail)}
              </p>
              {detail.textStatus === 'done' && detail.text && (
                <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-sans text-sm leading-relaxed text-foreground">
                  {detail.text}
                </pre>
              )}
            </>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          {fileUrl && (
            <a
              href={fileUrl}
              download={item.filename}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-md border border-border text-sm font-medium hover:bg-accent"
            >
              <Download className="h-4 w-4" />
              Save file
            </a>
          )}
          {detail && (detail.textStatus === 'failed' || detail.textStatus === 'none' ||
            detail.textStatus === 'idle') &&
            detail.kind !== 'file' && (
              <Button variant="secondary" className="flex-1" onClick={retry}>
                <RefreshCw className="mr-1.5 h-4 w-4" />
                {MEDIA.has(detail.kind) ? 'Transcribe' : 'Read again'}
              </Button>
            )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
