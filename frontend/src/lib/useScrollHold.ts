import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** How long after a touch, flick or wheel the view still counts as held. */
const HOLD_MS = 1200;

/**
 * Follow-scrolling that never fights the reader. While a finger is on the
 * scroll area, or for a moment after a flick or wheel (momentum), nothing
 * auto-scrolls: `mayScroll()` is false. A scroll up by hand detaches the
 * follow (`detached`) until the reader scrolls back near the end or calls
 * `follow()` (a "Jump to latest" button, or a new turn starting).
 *
 * Touch is read from touch events, not pointer events: the browser cancels a
 * pointer once it decides the gesture is a scroll, while the finger is still
 * down. Only scrolls the reader made count; the screen's own (smooth)
 * auto-scrolls fire scroll events too, and are ignored.
 */
export function useScrollHold(
  ref: RefObject<HTMLElement | null>,
  /** Re-attach when this changes (the scroll area mounts later). */
  mountKey: unknown = null,
) {
  const fingerDown = useRef(false);
  const touchedAt = useRef(0);
  const lastTop = useRef(0);
  const following = useRef(true);
  const [detached, setDetached] = useState(false);

  const setFollowing = useCallback((on: boolean) => {
    if (following.current === on) return;
    following.current = on;
    setDetached(!on);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const down = () => {
      fingerDown.current = true;
      touchedAt.current = Date.now();
    };
    const up = () => {
      fingerDown.current = false;
      touchedAt.current = Date.now();
    };
    const nudge = () => {
      touchedAt.current = Date.now();
    };
    const scroll = () => {
      const top = el.scrollTop;
      const wentUp = top < lastTop.current;
      lastTop.current = top;
      const byReader =
        fingerDown.current || Date.now() - touchedAt.current < HOLD_MS;
      if (!byReader) return;
      touchedAt.current = Date.now(); // momentum keeps it held
      // Near the end (the text may still be growing away from it) re-joins.
      const gap = el.scrollHeight - top - el.clientHeight;
      if (gap < 48 || (!wentUp && gap < el.clientHeight / 3)) {
        setFollowing(true);
      } else if (wentUp) {
        setFollowing(false);
      }
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', up, { passive: true });
    el.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    el.addEventListener('wheel', nudge, { passive: true });
    el.addEventListener('scroll', scroll, { passive: true });
    return () => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
      el.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
      el.removeEventListener('wheel', nudge);
      el.removeEventListener('scroll', scroll);
    };
  }, [ref, setFollowing, mountKey]);

  /** True when an auto-scroll may run: following, and not held. */
  const mayScroll = useCallback(
    () =>
      following.current &&
      !fingerDown.current &&
      Date.now() - touchedAt.current >= HOLD_MS,
    [],
  );
  /** Whether the reader has a finger on it (or just flicked it). */
  const held = useCallback(
    () => fingerDown.current || Date.now() - touchedAt.current < HOLD_MS,
    [],
  );
  const follow = useCallback(() => setFollowing(true), [setFollowing]);

  return { mayScroll, held, detached, follow, following };
}
