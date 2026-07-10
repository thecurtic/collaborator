/**
 * Chat-proposed drafts (propose_note) arrive WITHOUT source_turns — only
 * synthesis drafts get attributed by the backend today. Until the backend
 * stamps the proposing turn on the draft (the durable fix; PATCH can't set
 * source_turns), remember draftId → turn id client-side when the
 * drafts_proposed event and the turn's done event pair up.
 */
const KEY = 'collaborator_draft_origins';
const MAX = 300;

let cache: Map<number, number> | null = null;

function hydrate(): Map<number, number> {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      for (const [id, turn] of JSON.parse(raw) as [number, number][]) {
        if (typeof id === 'number' && typeof turn === 'number')
          cache.set(id, turn);
      }
    }
  } catch {
    /* start fresh */
  }
  return cache;
}

export function saveDraftOrigins(draftIds: number[], turnId: number): void {
  if (draftIds.length === 0) return;
  const map = hydrate();
  for (const id of draftIds) {
    map.delete(id);
    map.set(id, turnId);
  }
  while (map.size > MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify([...map.entries()]));
  } catch {
    /* in-memory still works this session */
  }
}

export function getDraftOrigin(draftId: number): number | null {
  return hydrate().get(draftId) ?? null;
}
