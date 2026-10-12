/**
 * Type tags (NOTES-FORMAT.md, 2026-10-12): the three tags whose notes carry
 * fields of their own. Exclusive — a note wears at most one — and they alone
 * decide which fields a note has. Every other tag, `project` included, is
 * ordinary.
 */
export const TYPE_TAGS = ['event', 'social-graph', 'user-profile'] as const;

/**
 * Notes lenses: the type tags plus `project`. goal, decision, question and
 * memory are plain tags with no lens of their own (UX doc).
 */
export interface NoteCategory {
  tag: string;
  label: string;
}

export const NOTE_CATEGORIES: NoteCategory[] = [
  { tag: 'user-profile', label: 'Profile' },
  { tag: 'social-graph', label: 'People' },
  { tag: 'project', label: 'Projects' },
  { tag: 'event', label: 'Events' },
];

/** USER.md fixed section headings, lowercased = valid `area` values. */
export const PROFILE_AREAS = [
  'background',
  'significant relationships',
  'work',
  'interests',
  'philosophy & values',
  'health & habits',
  'preferences',
  'current focus',
];

const TYPES = new Set<string>(TYPE_TAGS);
const BY_TAG = new Map(NOTE_CATEGORIES.map((c) => [c.tag, c]));

/** The note's type tag (decides its fields and badge), or null if untyped. */
export function categoryOf(tags: string[]): NoteCategory | null {
  for (const t of tags) {
    if (TYPES.has(t)) return BY_TAG.get(t) ?? null;
  }
  return null;
}
