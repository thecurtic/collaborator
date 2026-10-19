import { ArrowDown } from 'lucide-react';

/** Shown while the reader has scrolled away from a live view; re-joins it. */
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-md"
    >
      <ArrowDown className="h-3.5 w-3.5" />
      Jump to latest
    </button>
  );
}
