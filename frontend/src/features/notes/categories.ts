/**
 * Reserved extended-cognition tag vocabulary (backend 5b3e491). The model
 * proposes drafts carrying these; the UI promotes them from plain tags to
 * category badges and browse chips. `event` ships with backend phase 2 —
 * listed now so the chip lights up the moment such notes exist.
 */
export interface NoteCategory {
  tag: string;
  label: string;
}

export const NOTE_CATEGORIES: NoteCategory[] = [
  { tag: 'user-profile', label: 'Profile' },
  { tag: 'social-graph', label: 'People' },
  { tag: 'memory', label: 'Memories' },
  { tag: 'goal', label: 'Goals' },
  { tag: 'decision', label: 'Decisions' },
  { tag: 'question', label: 'Questions' },
  { tag: 'project', label: 'Projects' },
  { tag: 'event', label: 'Events' },
];

const BY_TAG = new Map(NOTE_CATEGORIES.map((c) => [c.tag, c]));

/** The first reserved category among `tags`, or null for uncategorized. */
export function categoryOf(tags: string[]): NoteCategory | null {
  for (const t of tags) {
    const c = BY_TAG.get(t);
    if (c) return c;
  }
  return null;
}
