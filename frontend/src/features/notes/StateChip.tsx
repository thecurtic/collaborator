import { useState } from 'react';
import { ActionSheet } from '@/components/ActionSheet';
import { cn } from '@/lib/utils';
import { CATEGORY_STATES } from './categories';

/** Visual tone per state value (shared across goal/question/project). */
function tone(state: string): string {
  switch (state) {
    case 'started':
    case 'open':
      return 'bg-primary/10 text-primary';
    case 'finished':
    case 'done':
    case 'answered':
      return 'bg-green-500/10 text-green-700';
    case 'paused':
      return 'bg-amber-500/10 text-amber-700';
    case 'discarded':
    case 'abandoned':
      return 'bg-muted text-muted-foreground line-through';
    default: // proposed
      return 'bg-accent text-accent-foreground';
  }
}

/**
 * The generic state chip (1f18a9b): shows `fields.state`, tap → ActionSheet
 * of that category's valid states → onChange (callers PATCH optimistically).
 * Renders nothing for categories without a state vocabulary.
 */
export function StateChip({
  category,
  state,
  onChange,
}: {
  category: string;
  /** null = backend default (first value in the vocabulary). */
  state: string | null;
  /** Omit for a read-only chip. */
  onChange?: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const states = CATEGORY_STATES[category];
  if (!states) return null;
  const current = state && states.includes(state) ? state : states[0];

  const chip = (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone(current),
      )}
    >
      {current}
    </span>
  );

  if (!onChange) return chip;
  return (
    <>
      <button
        type="button"
        aria-label={`Change state (currently ${current})`}
        title="Change state"
        onClick={(e) => {
          e.stopPropagation(); // chips live inside tappable rows
          setOpen(true);
        }}
        className="active:scale-95"
      >
        {chip}
      </button>
      <ActionSheet
        open={open}
        title={`Mark as…`}
        actions={states
          .filter((s) => s !== current)
          .map((s) => ({ label: s, onSelect: () => onChange(s) }))}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
