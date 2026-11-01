import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { UploadQueue, type UploadFn } from './uploadQueue';

export type { PendingUpload } from './uploadQueue';

/**
 * A draft's files and its send (UploadQueue): files upload as they're
 * added; `queue(args)` sends once they're all ready and nothing `blocked`
 * it; a failed upload holds the send until it's retried or removed.
 */
export function useUploadQueue<T, A>({
  upload,
  discard,
  send,
  max,
  blocked = false,
}: {
  upload: UploadFn<T>;
  discard?: (result: T) => void;
  send: (args: A) => void;
  max?: number;
  blocked?: boolean;
}) {
  const ref = useRef<UploadQueue<T, A> | null>(null);
  if (!ref.current) ref.current = new UploadQueue<T, A>({ upload, discard, send }, max);
  const q = ref.current;
  // The latest closures: a queued send fires with the draft as it is then.
  q.handlers = { upload, discard, send };

  useEffect(() => q.setBlocked(blocked), [q, blocked]);
  useEffect(() => () => q.abortAll(), [q]);

  const snap = useSyncExternalStore(q.subscribe, q.snapshot);
  const actions = useMemo(
    () => ({
      add: (list: FileList | File[]) => q.add(list),
      retry: (key: string) => q.retry(key),
      remove: (key: string) => q.remove(key),
      take: () => q.take(),
      restore: (back: ReturnType<UploadQueue<T, A>['take']>) => q.restore(back),
      release: (gone: ReturnType<UploadQueue<T, A>['take']>) => q.release(gone),
      queue: (args: A) => q.queue(args),
      cancel: () => q.cancel(),
    }),
    [q],
  );
  return { ...snap, ...actions };
}
