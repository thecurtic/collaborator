import { describe, expect, it } from 'vitest';
import { appendQuoteToDraft, quoteForReply } from './quote';

describe('quoteForReply', () => {
  it('quotes short paragraphs verbatim', () => {
    expect(quoteForReply('Short idea.')).toBe('> Short idea.');
  });

  it('collapses internal whitespace/newlines', () => {
    expect(quoteForReply('line one\nline  two')).toBe('> line one line two');
  });

  it('truncates long text on a word boundary with an ellipsis', () => {
    const long = `${'word '.repeat(40)}end`;
    const q = quoteForReply(long, 50);
    expect(q.startsWith('> word word')).toBe(true);
    expect(q.endsWith('…')).toBe(true);
    // "> " + snippet + "…" stays within budget and doesn't cut mid-word.
    expect(q.length).toBeLessThanOrEqual(53);
    expect(q).not.toMatch(/wor…$/);
  });

  it('strips trailing punctuation before the ellipsis', () => {
    const text = `${'a'.repeat(100)} and, ${'b'.repeat(100)}`;
    const q = quoteForReply(text, 106);
    expect(q).not.toMatch(/,…$/);
  });
});

describe('appendQuoteToDraft', () => {
  it('starts an empty draft with the quote and room to answer', () => {
    expect(appendQuoteToDraft('', '> q')).toBe('> q\n\n');
  });

  it('separates from existing text with a blank line', () => {
    expect(appendQuoteToDraft('> q1\n\nmy answer', '> q2')).toBe(
      '> q1\n\nmy answer\n\n> q2\n\n',
    );
  });

  it('normalizes trailing whitespace before appending', () => {
    expect(appendQuoteToDraft('answer\n\n', '> q')).toBe('answer\n\n> q\n\n');
  });
});
