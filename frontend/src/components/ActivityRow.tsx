import {
  Brain,
  Calculator,
  CalendarDays,
  Camera,
  Check,
  CircleSlash,
  FileVideo,
  FolderGit2,
  Globe,
  Link as LinkIcon,
  Loader2,
  NotebookPen,
  NotebookText,
  ScrollText,
  Wrench,
  X,
} from 'lucide-react';
import type { ToolActivity } from '@/domain/models';

/** Icon per tool family (activity feeds + sources sheets). */
export function toolIcon(tool: string) {
  if (tool === 'web_search') return Globe;
  if (tool === 'fetch_url') return LinkIcon;
  if (tool === 'screenshot_page') return Camera;
  if (tool.startsWith('recall')) return Brain;
  if (tool === 'search_notes' || tool === 'get_note' || tool === 'get_notes') {
    return NotebookText;
  }
  if (tool === 'propose_note') return NotebookPen;
  if (tool === 'read_logs') return ScrollText;
  if (tool === 'list_events') return CalendarDays;
  if (tool === 'calculate') return Calculator;
  if (tool === 'git_read') return FolderGit2;
  if (tool === 'transcribe_video') return FileVideo;
  return Wrench;
}

/**
 * One tool call: pending spinner → ✓ n results / ∅ empty / ✕ reason; 'none'
 * renders as a plain row (tools that don't report outcomes). With `showUrls`,
 * web_search result URLs list underneath as tappable links (sources sheets).
 */
export function ActivityRow({
  item,
  showUrls = false,
}: {
  item: ToolActivity;
  showUrls?: boolean;
}) {
  const Icon = toolIcon(item.tool);
  const isUrl = item.text.startsWith('http');
  return (
    <div>
      <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {isUrl ? (
          <a
            href={item.text}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate underline-offset-2 hover:underline"
          >
            {item.text}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate">{item.text}</span>
        )}
        <span className="flex shrink-0 items-center gap-1">
          {item.outcome === 'pending' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : item.outcome === 'ok' ? (
            <>
              {item.detail && <span>{item.detail}</span>}
              <Check className="h-3.5 w-3.5 text-primary" />
            </>
          ) : item.outcome === 'empty' ? (
            <>
              <span>no results</span>
              <CircleSlash className="h-3.5 w-3.5" />
            </>
          ) : item.outcome === 'error' ? (
            <>
              {item.detail && (
                <span className="max-w-[10rem] truncate text-destructive">
                  {item.detail}
                </span>
              )}
              <X className="h-3.5 w-3.5 text-destructive" />
            </>
          ) : null}
        </span>
      </div>
      {showUrls && item.urls && item.urls.length > 0 && (
        <ul className="ml-5 mt-1 space-y-0.5">
          {item.urls.map((u) => (
            <li key={u}>
              <a
                href={u}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-[11px] text-primary underline-offset-2 hover:underline"
              >
                {u}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
