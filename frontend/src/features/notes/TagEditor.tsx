import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TagAssist } from './TagAssist';
import { globalTagVocabulary, nearMissTags, normalizeTag } from './tags';

/**
 * Edit the tags on one thing that isn't a note (a chat, a transcript): chips
 * with remove, optional suggested tags, and an add box with completion. A new
 * tag that's a near-miss of an existing one asks before it's saved (UX doc:
 * tag hygiene is prevention). Every change goes straight to `onChange`.
 */
export function TagEditor({
  tags,
  onChange,
  vocabulary,
  proposals = [],
  disabled = false,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  /** Tags in use beyond the notes vault (chats, transcripts). */
  vocabulary: string[];
  /** Suggested tags, offered as one-tap adds (never applied on their own). */
  proposals?: string[];
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [noteVocab, setNoteVocab] = useState<string[]>([]);
  const [nearMiss, setNearMiss] = useState<
    { tag: string; existing: string[] } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void globalTagVocabulary().then((v) => {
      if (!cancelled) setNoteVocab(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const addTags = (added: string[]) => {
    const fresh = [...new Set(added)].filter((t) => t && !tags.includes(t));
    if (fresh.length) onChange([...tags, ...fresh]);
  };

  const addDraft = () => {
    const added = draft.split(',').map(normalizeTag).filter(Boolean);
    if (!added.length) return;
    const vocab = [...new Set([...noteVocab, ...vocabulary])];
    for (const t of added) {
      if (vocab.includes(t) || tags.includes(t)) continue;
      const near = nearMissTags(t, vocab);
      if (near.length) {
        setNearMiss({ tag: t, existing: near });
        return;
      }
    }
    setDraft('');
    addTags(added);
  };

  /** Resolve the near-miss question: `use` replaces the new tag (or keeps it). */
  const resolveNearMiss = (use: string) => {
    if (!nearMiss) return;
    const added = draft
      .split(',')
      .map(normalizeTag)
      .filter(Boolean)
      .map((t) => (t === nearMiss.tag ? use : t));
    setNearMiss(null);
    setDraft('');
    addTags(added);
  };

  const offered = proposals.filter((t) => !tags.includes(t));

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {tags.length === 0 && (
          <span className="text-xs italic text-muted-foreground">No tags yet</span>
        )}
        {tags.map((t) => (
          <span
            key={t}
            className="flex items-center gap-1 rounded-full bg-accent py-0.5 pl-2.5 pr-1 text-xs text-accent-foreground"
          >
            {t}
            <button
              type="button"
              aria-label={`Remove ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
              className="rounded-full p-0.5 hover:bg-background/60"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      {offered.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Suggested:</span>
          {offered.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onChange([...tags, t])}
              className="flex items-center gap-0.5 rounded-full border border-dashed border-primary/50 px-2 py-0.5 text-xs text-primary hover:bg-primary/5"
            >
              <Plus className="h-3 w-3" />
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setNearMiss(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addDraft();
          }}
          disabled={disabled}
          placeholder="Add tags, comma-separated"
          aria-label="Add tags"
          className="min-h-[2.25rem] min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <Button onClick={addDraft} disabled={disabled || !draft.trim()}>
          Add
        </Button>
      </div>
      {nearMiss && (
        <div className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800">
          <p>
            Did you mean{' '}
            {nearMiss.existing.map((e) => `“${e}”`).join(' or ')} instead of
            “{nearMiss.tag}”?
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {nearMiss.existing.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => resolveNearMiss(e)}
                className="rounded-full bg-amber-500/20 px-2 py-0.5 font-medium hover:bg-amber-500/30"
              >
                Use {e}
              </button>
            ))}
            <button
              type="button"
              onClick={() => resolveNearMiss(nearMiss.tag)}
              className="rounded-full px-2 py-0.5 hover:bg-amber-500/20"
            >
              Keep {nearMiss.tag}
            </button>
          </div>
        </div>
      )}
      <div className="mt-1.5">
        <TagAssist
          tagsText={draft}
          originalTags={tags}
          onComplete={(next) => setDraft(next)}
          extraVocab={vocabulary}
        />
      </div>
    </div>
  );
}
