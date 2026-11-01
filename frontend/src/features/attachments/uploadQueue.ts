import { isMediaFile } from './attachmentsApi';

/** A file on its way into the next send: uploading, ready, or failed. */
export interface PendingUpload<T> {
  key: string;
  file: File;
  name: string;
  size: number;
  /** Local preview for images (revoked when the file goes). */
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'error';
  /** 0–1 while uploading. */
  progress: number;
  /** Audio or video. */
  media: boolean;
  /** What the upload returned (an attachment, an upload id). */
  result?: T;
  error?: string;
}

export type UploadFn<T> = (
  file: File,
  name: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
) => Promise<T>;

export interface UploadHandlers<T, A> {
  upload: UploadFn<T>;
  /** Undo an upload that will never be sent (best-effort). */
  discard?: (result: T) => void;
  /** Send the draft: the files are all ready when this is called. */
  send: (args: A) => void;
}

export interface UploadSnapshot<T> {
  items: PendingUpload<T>[];
  uploading: boolean;
  failed: boolean;
  /** A send is waiting for uploads (or for `blocked` to clear). */
  queued: boolean;
  /** …and a failed upload is holding it: nothing goes until it's retried or removed. */
  held: boolean;
}

// Previews need a browser (tests run in node, where URL lacks these).
const hasObjectUrls = () => typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
const objectUrl = (file: File) =>
  hasObjectUrls() && file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
const revoke = (url: string | null) => {
  if (url && hasObjectUrls()) URL.revokeObjectURL(url);
};

let seq = 0;

/**
 * The files of a draft (a chat message, a Scratch capture) and its send.
 *
 * Files upload the moment they're added, each with its own progress; a
 * failed one stays, with a retry, until it's retried or removed. A send
 * asked for while uploads are running is queued and goes out by itself
 * once every file is ready (and nothing `blocked` it, such as a reply
 * still streaming); a failed upload holds it, so nothing is sent until
 * that file is retried or removed.
 */
export class UploadQueue<T, A> {
  private items: PendingUpload<T>[] = [];
  private queuedArgs: { args: A } | null = null;
  private blocked = false;
  private aborts = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private snap: UploadSnapshot<T>;
  readonly max: number;
  handlers: UploadHandlers<T, A>;

  constructor(handlers: UploadHandlers<T, A>, max = Infinity) {
    this.handlers = handlers;
    this.max = max;
    this.snap = this.compute();
  }

  // --- the store (useSyncExternalStore) ---

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.snap;

  private compute(): UploadSnapshot<T> {
    const uploading = this.items.some((f) => f.status === 'uploading');
    const failed = this.items.some((f) => f.status === 'error');
    return {
      items: this.items,
      uploading,
      failed,
      queued: this.queuedArgs !== null,
      held: this.queuedArgs !== null && failed,
    };
  }

  private changed() {
    this.snap = this.compute();
    this.listeners.forEach((l) => l());
    const q = this.queuedArgs;
    if (q && !this.blocked && !this.snap.uploading && !this.snap.failed) {
      this.queuedArgs = null;
      this.snap = this.compute();
      this.listeners.forEach((l) => l());
      this.handlers.send(q.args);
    }
  }

  private set(items: PendingUpload<T>[]) {
    this.items = items;
    this.changed();
  }

  private patch(key: string, p: Partial<PendingUpload<T>>) {
    if (!this.items.some((f) => f.key === key)) return;
    this.set(this.items.map((f) => (f.key === key ? { ...f, ...p } : f)));
  }

  private start(f: PendingUpload<T>) {
    const abort = new AbortController();
    this.aborts.set(f.key, abort);
    this.handlers
      .upload(f.file, f.name, abort.signal, (progress) => {
        if (!abort.signal.aborted) this.patch(f.key, { progress });
      })
      .then((result) => {
        if (abort.signal.aborted) {
          this.handlers.discard?.(result);
          return;
        }
        this.patch(f.key, { status: 'ready', progress: 1, result });
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        this.patch(f.key, {
          status: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        });
      })
      .finally(() => {
        if (this.aborts.get(f.key) === abort) this.aborts.delete(f.key);
      });
  }

  // --- files ---

  /** Add files (beyond `max` are ignored); returns the keys given them. */
  add(list: FileList | File[]): string[] {
    const room = Math.max(0, this.max - this.items.length);
    const added = Array.from(list)
      .slice(0, room)
      .map((file): PendingUpload<T> => {
        const name = file.name || 'pasted-file';
        return {
          key: `u${++seq}`,
          file,
          name,
          size: file.size,
          previewUrl: objectUrl(file),
          status: 'uploading',
          progress: 0,
          media: isMediaFile(file.type, name),
        };
      });
    if (!added.length) return [];
    this.set([...this.items, ...added]);
    added.forEach((f) => this.start(f));
    return added.map((f) => f.key);
  }

  retry(key: string) {
    const f = this.items.find((x) => x.key === key);
    if (!f || f.status !== 'error') return;
    const again = { ...f, status: 'uploading' as const, progress: 0, error: undefined };
    this.set(this.items.map((x) => (x.key === key ? again : x)));
    this.start(again);
  }

  /** Take a file back out; an upload already made is discarded. */
  remove(key: string) {
    const f = this.items.find((x) => x.key === key);
    if (!f) return;
    this.aborts.get(key)?.abort();
    this.aborts.delete(key);
    revoke(f.previewUrl);
    if (f.result !== undefined) this.handlers.discard?.(f.result);
    this.set(this.items.filter((x) => x.key !== key));
  }

  /** Hand every file over (the send): cleared without discarding. */
  take(): PendingUpload<T>[] {
    const taken = this.items;
    this.set([]);
    return taken;
  }

  /** Put files back (a send that failed), unless new ones came meanwhile. */
  restore(back: PendingUpload<T>[]) {
    if (!this.items.length) this.set(back);
  }

  /** Previews of files that are gone for good. */
  release(gone: PendingUpload<T>[]) {
    gone.forEach((f) => revoke(f.previewUrl));
  }

  // --- the send ---

  /** Send now when every file is ready, else as soon as they are. */
  queue(args: A) {
    this.queuedArgs = { args };
    this.changed();
  }

  cancel() {
    if (!this.queuedArgs) return;
    this.queuedArgs = null;
    this.changed();
  }

  /** Something other than uploads the send must wait for (a reply streaming). */
  setBlocked(blocked: boolean) {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.changed();
  }

  /** Leaving: stop every upload. */
  abortAll() {
    this.aborts.forEach((a) => a.abort());
    this.aborts.clear();
  }
}
