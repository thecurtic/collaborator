import { useRef, type MouseEvent, type PointerEvent } from 'react';

const MOVE_TOLERANCE_PX = 10;

/**
 * Long-press (tap-and-hold) interaction: fires `onLongPress` after `ms` of
 * steady contact; movement (scrolling) or release cancels. A normal tap falls
 * through to `onClick`. Desktop right-click also opens (same intent), and the
 * suppressed contextmenu keeps mobile browsers' native callout out of the way.
 *
 * Give the target `select-none` (and ideally `[-webkit-touch-callout:none]`)
 * so iOS doesn't start text selection during the hold.
 */
export function useLongPress(
  onLongPress: () => void,
  opts: {
    onClick?: () => void;
    ms?: number;
    /**
     * Gate: return false to let this press through untouched (e.g. holds on
     * child regions that own their own hold behavior, like selectable text).
     * Also skips the contextmenu suppression for those targets.
     */
    shouldStart?: (e: PointerEvent | MouseEvent) => boolean;
  } = {},
) {
  const { onClick, ms = 500, shouldStart } = opts;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  };

  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      if (shouldStart && !shouldStart(e)) return;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, ms);
    },
    onPointerMove: (e: PointerEvent) => {
      if (!origin.current || !timer.current) return;
      const d = Math.hypot(
        e.clientX - origin.current.x,
        e.clientY - origin.current.y,
      );
      if (d > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onClick: (e: MouseEvent) => {
      if (fired.current) {
        // The hold already acted — swallow the click that follows release.
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
        return;
      }
      onClick?.();
    },
    onContextMenu: (e: MouseEvent) => {
      // Excluded targets keep their native context menu (copy on selections).
      if (shouldStart && !shouldStart(e)) return;
      // Desktop right-click = same intent; also blocks Android's native
      // long-press menu from stacking on top of ours.
      e.preventDefault();
      if (!fired.current) {
        cancel();
        fired.current = true;
        onLongPress();
      }
    },
  };
}
