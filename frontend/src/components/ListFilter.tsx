import { ListFilter as FilterIcon, X } from 'lucide-react';
import { useState } from 'react';
import { ActionSheet } from '@/components/ActionSheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface FilterOption<K extends string> {
  key: K;
  label: string;
}

/**
 * The quiet list filter (UX doc: "a control I reach for once the list has
 * grown rather than a row of chips always on screen"). An icon in the
 * header opens the derived filters; the active one shows as a chip under
 * the header (see ActiveFilter) until it's cleared.
 */
export function ListFilterButton<K extends string>({
  options,
  value,
  onChange,
  title,
}: {
  options: FilterOption<K>[];
  /** The active filter, or null for everything. */
  value: K | null;
  onChange: (key: K | null) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Filter"
        title="Filter"
        aria-pressed={value !== null}
        onClick={() => setOpen(true)}
        className={cn('h-8 w-8', value ? 'text-primary' : 'text-muted-foreground')}
      >
        <FilterIcon className="h-4 w-4" />
      </Button>
      <ActionSheet
        open={open}
        title={title}
        actions={[
          { label: 'Everything', onSelect: () => onChange(null) },
          ...options.map((o) => ({ label: o.label, onSelect: () => onChange(o.key) })),
        ]}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** The active filter, shown while it narrows the list; × clears it. */
export function ActiveFilter({
  label,
  count,
  more = false,
  onClear,
}: {
  label: string | null;
  count: number;
  /** More match than are loaded (the count is a floor). */
  more?: boolean;
  onClear: () => void;
}) {
  if (!label) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
      <span className="flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 font-medium text-primary">
        {label}
        <button
          type="button"
          aria-label={`Clear filter: ${label}`}
          onClick={onClear}
          className="rounded-full p-0.5 hover:bg-primary/15"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
      <span className="tabular-nums">
        {count}
        {more ? '+' : ''} {count === 1 && !more ? 'item' : 'items'}
      </span>
    </div>
  );
}
