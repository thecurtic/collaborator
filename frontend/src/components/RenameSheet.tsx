import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';

/** Bottom sheet with a single name input (rename flows from long-press menus). */
export function RenameSheet({
  open,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const panelRef = useModalA11y<HTMLDivElement>(open, onClose);

  // Fresh value each time the sheet opens for a (possibly different) target.
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  if (!open) return null;

  const commit = () => {
    onSave(value);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Cancel"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Rename"
        tabIndex={-1}
        className="pb-safe relative w-full rounded-t-2xl border border-border bg-card p-4 outline-none sm:max-w-sm sm:rounded-2xl"
      >
        <p className="mb-2 text-sm font-medium">Rename</p>
        <div className="flex gap-2">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
            placeholder="Name"
            className="min-h-[2.5rem] flex-1 rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          />
          <Button onClick={commit}>Save</Button>
        </div>
      </div>
    </div>
  );
}
