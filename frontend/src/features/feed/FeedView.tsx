import {
  CalendarDays,
  FileText,
  FileVideo,
  GitMerge,
  Inbox,
  Loader2,
  MessageSquare,
  Pin,
  PinOff,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { api } from '@/api/collaborator';
import { ActionSheet } from '@/components/ActionSheet';
import { Button } from '@/components/ui/button';
import type { Feed, FeedItem, FeedItemType } from '@/domain/models';
import { useLongPress } from '@/lib/useLongPress';
import { cn } from '@/lib/utils';
import { formatEventRange } from '@/features/notes/eventFields';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const ICONS: Record<FeedItemType, ComponentType<{ className?: string }>> = {
  chat: MessageSquare,
  note: FileText,
  event: CalendarDays,
  approval: Inbox,
  transcript: FileVideo,
  merged: GitMerge,
};

/** "5m", "3h", "2d", or a date — how long ago an item warmed. */
function ago(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  if (mins < 14 * 24 * 60) return `${Math.round(mins / (24 * 60))}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The line under the title, by what the item is. */
function detail(item: FeedItem): string | null {
  if (item.type === 'event' && item.ref.start) {
    return formatEventRange({
      start: item.ref.start,
      end: null,
      allDay: item.ref.start.length === 10,
    });
  }
  return item.subtitle;
}

function Row({
  item,
  onOpen,
  onMenu,
}: {
  item: FeedItem;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const press = useLongPress(onMenu, { onClick: onOpen });
  const Icon = ICONS[item.type];
  const when = item.type === 'event' ? null : ago(item.warmth);
  const line = detail(item);
  return (
    <button
      type="button"
      {...press}
      title="Hold to pin"
      className="flex w-full select-none items-start gap-3 px-4 py-3 text-left [-webkit-touch-callout:none] hover:bg-muted/60 active:bg-muted"
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          item.type === 'approval' ? 'text-amber-600' : 'text-primary/70',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {item.title}
          </span>
          {item.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
          {when && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{when}</span>
          )}
        </span>
        {line && (
          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
            {line}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The warm feed (UX doc, Feed): what I was just doing and what moved while I
 * was away, in one list ordered by warmth — the later of last touched and
 * last changed. Pinned items stay on top. Tapping opens the item where it
 * lives; holding pins or unpins it.
 */
export function FeedView({
  onOpen,
}: {
  /** Navigate to an item (the app shell knows where each type lives). */
  onOpen: (item: FeedItem) => void;
}) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuItem, setMenuItem] = useState<FeedItem | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFeed(await api.getFeed());
    } catch (err) {
      setError(errMessage(err));
      setFeed((prev) => prev ?? { pinned: [], items: [] });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePin = (item: FeedItem) => {
    api
      .pinFeedItem(item.key, !item.pinned)
      .then(load)
      .catch((err) => setError(errMessage(err)));
  };

  const all = feed ? [...feed.pinned, ...feed.items] : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-2xl font-semibold">Feed</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          onClick={() => void load()}
          className="h-8 w-8 text-muted-foreground"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {feed === null ? (
          <p className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : all.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <p className="text-lg font-medium text-foreground">Nothing warm yet</p>
            <p className="mt-1 px-8 text-sm">
              Chats, notes you open, upcoming events and anything waiting on you
              show up here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {all.map((item, i) => (
              <li
                key={item.key}
                className={cn(
                  i === feed.pinned.length - 1 &&
                    feed.items.length > 0 &&
                    'border-b-2 border-b-border',
                )}
              >
                <Row
                  item={item}
                  onOpen={() => onOpen(item)}
                  onMenu={() => setMenuItem(item)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <ActionSheet
        open={menuItem !== null}
        title={menuItem?.title}
        actions={
          menuItem
            ? [
                {
                  label: menuItem.pinned ? 'Unpin' : 'Pin to top',
                  icon: menuItem.pinned ? PinOff : Pin,
                  onSelect: () => togglePin(menuItem),
                },
              ]
            : []
        }
        onClose={() => setMenuItem(null)}
      />
    </div>
  );
}
