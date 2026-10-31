import {
  FileText,
  FileVideo,
  Globe,
  LogOut,
  Menu,
  Receipt,
  ScrollText,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';

function MenuItem({
  icon: Icon,
  children,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-foreground hover:bg-muted active:bg-muted"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      {children}
    </button>
  );
}

/**
 * The app-wide hamburger menu (top right, every screen). Non-contextual by
 * design — a fixed set of global destinations, extensible over time.
 */
export function AppMenu({
  onOpenSettings,
  onOpenWebSearch,
  onOpenTranscripts,
  onOpenNotes,
  onOpenPeople,
  onOpenToolLog,
  onOpenSpending,
  onSignOut,
}: {
  onOpenSettings: () => void;
  onOpenWebSearch: () => void;
  onOpenTranscripts: () => void;
  onOpenNotes: () => void;
  onOpenPeople: () => void;
  onOpenToolLog: () => void;
  onOpenSpending: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useModalA11y<HTMLDivElement>(open, () => setOpen(false));

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="h-10 w-10"
      >
        <Menu className="h-5 w-5" />
      </Button>
      {open && (
        <>
          {/* Invisible backdrop: tap-outside closes. */}
          <button
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            ref={panelRef}
            role="menu"
            aria-label="Menu"
            tabIndex={-1}
            className="absolute right-0 top-full z-50 mt-1 w-52 rounded-xl border border-border bg-card py-1 shadow-lg outline-none"
          >
            {/* The archives consulted on purpose (UX doc, Destinations). */}
            <MenuItem icon={FileText} onClick={() => pick(onOpenNotes)}>
              Notes
            </MenuItem>
            <MenuItem icon={Users} onClick={() => pick(onOpenPeople)}>
              People
            </MenuItem>
            <MenuItem icon={FileVideo} onClick={() => pick(onOpenTranscripts)}>
              Transcripts
            </MenuItem>
            <MenuItem icon={Receipt} onClick={() => pick(onOpenSpending)}>
              Spending
            </MenuItem>
            <div className="my-1 border-t border-border" />
            <MenuItem icon={Globe} onClick={() => pick(onOpenWebSearch)}>
              Web Search
            </MenuItem>
            <MenuItem icon={ScrollText} onClick={() => pick(onOpenToolLog)}>
              Tool log
            </MenuItem>
            <MenuItem icon={SettingsIcon} onClick={() => pick(onOpenSettings)}>
              Settings
            </MenuItem>
            <div className="my-1 border-t border-border" />
            <MenuItem icon={LogOut} onClick={() => pick(onSignOut)}>
              Sign out
            </MenuItem>
          </div>
        </>
      )}
    </div>
  );
}
