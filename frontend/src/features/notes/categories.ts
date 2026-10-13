/**
 * Type tags (NOTES-FORMAT.md, 2026-10-12): the three tags whose notes carry
 * fields of their own. Exclusive — a note wears at most one — and they alone
 * decide which fields a note has. Every other tag, `project` included, is
 * ordinary.
 */
export const TYPE_TAGS = ['event', 'social-graph', 'user-profile'] as const;

/**
 * Notes lenses: the person and profile types plus `project`. Events have
 * their own destination (Calendar); goal, decision, question and memory are
 * plain tags with no lens of their own (UX doc).
 */
export interface NoteCategory {
  tag: string;
  label: string;
}

export const NOTE_CATEGORIES: NoteCategory[] = [
  { tag: 'user-profile', label: 'Profile' },
  { tag: 'social-graph', label: 'People' },
  { tag: 'project', label: 'Projects' },
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

/** Badge labels per type tag (independent of which lenses exist). */
const TYPE_LABELS: Record<(typeof TYPE_TAGS)[number], string> = {
  event: 'Event',
  'social-graph': 'Person',
  'user-profile': 'Profile',
};

/** The note's type tag (decides its fields and badge), or null if untyped. */
export function categoryOf(tags: string[]): NoteCategory | null {
  for (const t of tags) {
    if (t in TYPE_LABELS) {
      return { tag: t, label: TYPE_LABELS[t as keyof typeof TYPE_LABELS] };
    }
  }
  return null;
}
