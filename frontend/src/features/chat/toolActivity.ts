import type { ToolStatusEvent } from '@/api/collaborator';
import type { ToolActivity } from '@/domain/models';

/**
 * Fold a status event into an activity feed: starts append a pending row;
 * outcomes resolve the LAST pending row for that tool (tool calls run
 * sequentially, and outcome events carry no id to match on). Pure — shared by
 * text chat and call mode.
 */
export function foldToolEvent(
  prev: ToolActivity[],
  e: ToolStatusEvent,
): ToolActivity[] {
  if (!e.isOutcome) {
    return [
      ...prev,
      {
        id: prev.length,
        tool: e.tool,
        text: e.query ?? e.url ?? e.title ?? e.label,
        outcome: 'pending',
        detail: null,
      },
    ];
  }
  const outcome = e.outcome ?? 'ok';
  const detail =
    e.error ??
    (typeof e.count === 'number'
      ? `${e.count} ${e.count === 1 ? 'result' : 'results'}`
      : null);
  let i = prev.length - 1;
  while (i >= 0 && !(prev[i].tool === e.tool && prev[i].outcome === 'pending'))
    i--;
  if (i < 0) {
    // Outcome without a visible start — show it as its own resolved row.
    return [
      ...prev,
      { id: prev.length, tool: e.tool, text: e.label, outcome, detail },
    ];
  }
  const next = prev.slice();
  next[i] = { ...next[i], outcome, detail, urls: e.urls };
  return next;
}
