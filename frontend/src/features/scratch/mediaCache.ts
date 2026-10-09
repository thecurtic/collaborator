import { api } from '@/api/collaborator';

/**
 * Object-URL cache for scratch media, keyed by content hash (media is
 * content-addressed server-side, so the hash is stable and duplicate
 * captures share one entry). Fetched through the HTTP layer because media
 * serving is authenticated — a bare <img src> can't attach X-Session in the
 * Android shell. Bounded FIFO; evicted URLs are revoked.
 */
const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const order: string[] = [];
const MAX_ENTRIES = 100;

export function scratchMediaUrl(id: number, hash: string): Promise<string> {
  const hit = urls.get(hash);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(hash);
  if (inFlight) return inFlight;
  const p = api
    .getScratchMedia(id)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      urls.set(hash, url);
      order.push(hash);
      if (order.length > MAX_ENTRIES) {
        const evicted = order.shift();
        if (evicted) {
          const u = urls.get(evicted);
          if (u) URL.revokeObjectURL(u);
          urls.delete(evicted);
        }
      }
      pending.delete(hash);
      return url;
    })
    .catch((err: unknown) => {
      pending.delete(hash);
      throw err;
    });
  pending.set(hash, p);
  return p;
}
