import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

// Stack of active modals — only the topmost one traps focus / handles Escape,
// so Settings opened over the call screen doesn't fight its trap.
const stack: symbol[] = [];

/**
 * Dialog semantics for an overlay. Attach the returned ref to the dialog
 * container (with `tabIndex={-1}`, `role="dialog"`, `aria-modal="true"`, and an
 * aria-label). While `active`:
 *   - focus moves into the dialog on open (respecting any autoFocus inside),
 *   - Tab / Shift+Tab cycle within it,
 *   - Escape calls `onClose` (omit onClose to disable — e.g. an active call),
 *   - on close, focus returns to the element that opened it.
 *
 * Escape listens on the document bubble phase, so an inner handler (e.g. a
 * rename input) can claim the key first with `e.stopPropagation()`.
 */
export function useModalA11y<T extends HTMLElement>(
  active: boolean,
  onClose?: () => void,
) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const token = Symbol('modal');
    stack.push(token);
    const isTop = () => stack[stack.length - 1] === token;
    const opener = document.activeElement as HTMLElement | null;

    // Move focus inside unless something in the dialog (autoFocus) has it.
    if (!el.contains(document.activeElement)) el.focus();

    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        if (onCloseRef.current) {
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(
        el.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((n) => n.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!el.contains(current)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (current === first || current === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(token), 1);
      opener?.focus?.();
    };
  }, [active]);

  return ref;
}
