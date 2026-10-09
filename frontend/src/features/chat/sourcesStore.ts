import type { ToolActivity } from '@/domain/models';

/**
 * Per-turn tool-activity cache (the "Sources" button's data), keyed by the
 * assistant turn id. CLIENT-SIDE ONLY: the backend doesn't persist tool
 * activity per turn yet, so this survives reloads on this device via
 * localStorage but not across devices. When the backend grows a per-turn
 * `tools`/sources field on the tree, prefer that and retire this.
 */
const KEY = 'collaborator_turn_sources';
const MAX_TURNS = 200; // insertion-ordered cap — oldest entries drop first

let cache: Map<number, ToolActivity[]> | null = null;

function hydrate(): Map<number, ToolActivity[]> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      for (const [id, items] of JSON.parse(raw) as [number, ToolActivity[]][]) {
        if (typeof id === 'number' && Array.isArray(items))
          cache.set(id, items);
      }
    }
  } catch {
    /* corrupt/unavailable storage — start fresh */
  }
  return cache;
}

function persist(map: Map<number, ToolActivity[]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...map.entries()]));
  } catch {
    /* storage full/blocked — the in-memory cache still works this session */
  }
}

export function saveTurnSources(turnId: number, items: ToolActivity[]): void {
  if (items.length === 0) return;
  const map = hydrate();
  map.delete(turnId); // re-insert to refresh its position in the cap order
  map.set(turnId, items);
  while (map.size > MAX_TURNS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  persist(map);
}

export function getTurnSources(turnId: number): ToolActivity[] {
  return hydrate().get(turnId) ?? [];
}
