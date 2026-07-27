import { SendHorizontal, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Scratch — "notes to self". A quick-capture stream for shuttling text
 * between devices (the Signal-to-self replacement): type, send, and it lands
 * in a newest-first list with per-item copy — NOT a chat thread, and
 * deliberately outside the knowledge graph so scratch traffic never pollutes
 * the vault or the agent's searches.
 *
 * PLACEHOLDER: the capture UI is real but disabled — entries need a backend
 * resource (text + created_at, list/delete) before anything can sync across
 * devices, and the feature design isn't settled yet. Planned: per-item copy
 * button, tracking-param stripping on pasted links (lib/urlClean, same as the
 * composer), promote-to-vault-note as an explicit action, and registering the
 * PWA as an Android share target so any app's share sheet can drop text here.
 */
export function ScratchView() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-2xl font-semibold">Scratch</h2>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-muted-foreground">
        <StickyNote className="h-10 w-10 opacity-40" />
        <p className="text-lg font-medium text-foreground">Notes to self</p>
        <p className="max-w-sm text-sm">
          Fire off links, addresses, snippets — anything you'd message
          yourself — and they appear here as a list on every device. Coming
          soon: the backend piece that makes them sync.
        </p>
      </div>

      {/* The capture bar, visually final but inert until the backend lands. */}
      <div className="px-safe pb-safe border-t border-border bg-background">
        <div className="px-3 pb-5 pt-3 sm:px-4">
          <div className="flex items-end gap-2 rounded-2xl border border-input bg-card px-3 py-2 opacity-60">
            <textarea
              rows={1}
              disabled
              placeholder="Note to self… (coming soon)"
              className="max-h-40 min-h-[2.25rem] w-full resize-none border-0 bg-transparent px-1 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
            />
            <Button
              type="button"
              size="icon"
              disabled
              aria-label="Send note to self (coming soon)"
              className="h-9 w-9 shrink-0 rounded-full"
            >
              <SendHorizontal className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
