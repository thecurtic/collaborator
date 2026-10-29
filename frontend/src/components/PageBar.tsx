import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { goBack } from '@/lib/back';

/**
 * The title row of a pushed screen or a detail view: back, the title, then
 * the screen's own actions. The top bar above it only holds what every
 * screen shares (health, search, the gate switch, the menu), so a screen
 * is titled once, here. Back defaults to the app's back stack, the same
 * step the back gesture takes.
 */
export function PageBar({
  title,
  onBack = goBack,
  backLabel = 'Back',
  children,
}: {
  title: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-3">
      <Button
        variant="ghost"
        size="icon"
        aria-label={backLabel}
        onClick={() => onBack()}
        className="h-9 w-9 shrink-0"
      >
        <ChevronLeft className="h-5 w-5" />
      </Button>
      <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}
