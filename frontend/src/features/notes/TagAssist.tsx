import { useEffect, useMemo, useState } from 'react';
import { globalTagVocabulary, nearMissTags, suggestTags } from './tags';

/**
 * Assist row for a comma-separated tags input: prefix completions for the
 * tag being typed (tap to complete) and amber near-miss warnings for
 * completed NEW tags — forking a tag should be deliberate, not accidental.
 * Purely advisory; never blocks.
 */
export function TagAssist({
  tagsText,
  originalTags,
  onComplete,
}: {
  tagsText: string;
  /** Tags the note/draft already had — never warned about. */
  originalTags: string[];
  /** Replace the in-progress token with this completion. */
  onComplete: (nextTagsText: string) => void;
}) {
  const [vocab, setVocab] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void globalTagVocabulary().then((v) => {
      if (!cancelled) setVocab(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const parts = tagsText.split(',');
  const currentToken = parts[parts.length - 1] ?? '';
  const completedTags = parts
    .slice(0, -1)
    .map((t) => t.trim())
    .filter(Boolean);

  const suggestions = useMemo(
    () => suggestTags(currentToken, vocab, completedTags),
    [currentToken, vocab, completedTags],
  );

  const original = useMemo(
    () => new Set(originalTags.map((t) => t.toLowerCase())),
    [originalTags],
  );
  const warnings = useMemo(() => {
    const out: { tag: string; existing: string[] }[] = [];
    for (const tag of completedTags) {
      if (original.has(tag.toLowerCase())) continue;
      if (vocab.includes(tag)) continue; // exact reuse — the goal
      const near = nearMissTags(tag, vocab);
      if (near.length > 0) out.push({ tag, existing: near });
    }
    return out;
  }, [completedTags, vocab, original]);

  if (suggestions.length === 0 && warnings.length === 0) return null;
  return (
    <div className="space-y-1">
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() =>
                onComplete(`${[...completedTags, s].join(', ')}, `)
              }
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {warnings.map((w) => (
        <p
          key={w.tag}
          className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700"
        >
          “{w.tag}” is close to existing {w.existing.length === 1 ? 'tag' : 'tags'}{' '}
          {w.existing.map((e) => `“${e}”`).join(', ')} — keep it only if the
          fork is deliberate.
        </p>
      ))}
    </div>
  );
}
