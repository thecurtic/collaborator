import { api } from '@/api/collaborator';

/**
 * Global tag vocabulary: autocomplete + near-miss detection ("tag dedup at
 * approval"). Checks run against the GLOBAL tag set — tags are global, so
 * forking one ("Feature" vs "feature", "bugs" vs "bug") should be deliberate,
 * never accidental. Warn, don't block.
 */

let vocabPromise: Promise<string[]> | null = null;

/** All tags in use across the vault (cached per session). */
export function globalTagVocabulary(): Promise<string[]> {
  if (!vocabPromise) {
    vocabPromise = api
      .listNotes()
      .then((notes) => {
        const set = new Set<string>();
        for (const n of notes) for (const t of n.tags) set.add(t);
        return [...set].sort();
      })
      .catch(() => {
        vocabPromise = null; // transient — retry on next use
        return [];
      });
  }
  return vocabPromise;
}

/** New tags were approved — the cached vocabulary is stale. */
export function invalidateTagVocabulary(): void {
  vocabPromise = null;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(
        Math.min(
          prev[j] + 1,
          row[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Existing tags `candidate` is probably an accidental fork of: case
 * differences, plural/singular pairs, or a 1-2 char typo (length ≥5 on both
 * sides — short tags differ legitimately). Exact matches return nothing.
 */
export function nearMissTags(candidate: string, vocab: string[]): string[] {
  const c = candidate.toLowerCase();
  return vocab.filter((v) => {
    if (v === candidate) return false;
    const w = v.toLowerCase();
    if (w === c) return true;
    if (w === `${c}s` || c === `${w}s`) return true;
    if (Math.abs(w.length - c.length) > 2) return false;
    return c.length >= 5 && w.length >= 5 && levenshtein(c, w) <= 2;
  });
}

/** Prefix-matched completions for the tag being typed (autocomplete). */
export function suggestTags(
  prefix: string,
  vocab: string[],
  exclude: string[],
  limit = 6,
): string[] {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const taken = new Set(exclude.map((t) => t.toLowerCase()));
  return vocab
    .filter(
      (v) =>
        v.toLowerCase().startsWith(p) &&
        v.toLowerCase() !== p &&
        !taken.has(v.toLowerCase()),
    )
    .slice(0, limit);
}
