import type { ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useModalA11y } from '@/lib/useModalA11y';
import { cn } from '@/lib/utils';

export interface SheetAction {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void;
  destructive?: boolean;
}

/**
 * Bottom action sheet (centered dialog on desktop) — the long-press context
 * menu for rows and titles. Closes before running the chosen action.
 */
export function ActionSheet({
  open,
  title,
  actions,
  onClose,
}: {
  open: boolean;
  /** What the actions apply to (truncated subtitle line). */
  title?: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const panelRef = useModalA11y<HTMLDivElement>(open, onClose);
  if (!open) return null;

  // Portal to <body>: callers may sit inside reduced-opacity/stacking
  // contexts (e.g. a bubble's dimmed footer) that would ghost or clip a
  // fixed overlay rendered in place.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={panelRef}
        role="menu"
        aria-modal="true"
        aria-label={title ?? 'Actions'}
        tabIndex={-1}
        className="pb-safe relative w-full rounded-t-2xl border border-border bg-card p-2 outline-none sm:max-w-sm sm:rounded-2xl"
      >
        {title && (
          <p className="truncate px-3.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">
            {title}
          </p>
        )}
        {actions.map(({ label, icon: Icon, onSelect, destructive }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-3.5 py-3 text-left text-sm hover:bg-muted active:bg-muted',
              destructive ? 'text-destructive' : 'text-foreground',
            )}
          >
            {Icon && (
              <Icon
                className={cn(
                  'h-4 w-4',
                  destructive ? 'text-destructive' : 'text-muted-foreground',
                )}
              />
            )}
            {label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
