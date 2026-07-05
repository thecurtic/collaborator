import { describe, expect, it } from 'vitest';
import {
  currentParagraphIndex,
  extractSentences,
  sanitizeForSpeech,
  splitParagraphs,
  stripTrailingWord,
} from './speechUtils';

describe('extractSentences', () => {
  it('splits complete sentences and keeps the tail', () => {
    const { sentences, rest } = extractSentences('One. Two! Three is still going');
    expect(sentences).toEqual(['One. ', 'Two! ']);
    expect(rest).toBe('Three is still going');
  });

  it('never drops text (verbatim contiguous slices)', () => {
    const input = 'Alpha. Beta! Gamma? Tail without end';
    const { sentences, rest } = extractSentences(input);
    expect(sentences.join('') + rest).toBe(input);
  });

  it('handles punctuation inside markdown emphasis without losing text', () => {
    // Regression: the old regex dropped everything before "**bold.**".
    const input = 'Sentence one ending **bold.** Sentence two. And a tail';
    const { sentences, rest } = extractSentences(input);
    expect(sentences.join('') + rest).toBe(input);
    expect(sentences[0]).toBe('Sentence one ending **bold.** ');
    expect(sentences[1]).toBe('Sentence two. ');
    expect(rest).toBe('And a tail');
  });

  it('does not split decimals or bare newlines without punctuation', () => {
    const { sentences, rest } = extractSentences('Pi is 3.14159 and more\ntext');
    expect(sentences).toEqual([]);
    expect(rest).toBe('Pi is 3.14159 and more\ntext');
  });

  it('treats newline after punctuation as a boundary', () => {
    const input = 'First line.\nSecond line continues';
    const { sentences, rest } = extractSentences(input);
    expect(sentences).toEqual(['First line.\n']);
    expect(rest).toBe('Second line continues');
  });

  it('keeps closing quotes/brackets with the sentence', () => {
    const input = 'He said "stop." Then left';
    const { sentences } = extractSentences(input);
    expect(sentences[0]).toBe('He said "stop." ');
  });

  it('sentence lengths sum to exact offsets into the original text', () => {
    const input = 'A one. B two!  C three? Leftover';
    const { sentences, rest } = extractSentences(input);
    let offset = 0;
    for (const s of sentences) {
      expect(input.slice(offset, offset + s.length)).toBe(s);
      offset += s.length;
    }
    expect(input.slice(offset)).toBe(rest);
  });
});

describe('sanitizeForSpeech', () => {
  it('strips markdown but keeps the words', () => {
    expect(
      sanitizeForSpeech('# Title\n\nSome **bold** and `code` with [a link](http://x).'),
    ).toBe('Title Some bold and code with a link.');
  });

  it('drops fenced code blocks entirely', () => {
    expect(sanitizeForSpeech('Before\n```js\nconst x = 1;\n```\nAfter')).toBe(
      'Before After',
    );
  });

  it('returns empty for whitespace-only input', () => {
    expect(sanitizeForSpeech('   \n\n  ')).toBe('');
  });
});

describe('splitParagraphs', () => {
  it('keeps char offsets consistent with the original text', () => {
    const text = 'First para.\n\nSecond para.\n\n\nThird.';
    const paras = splitParagraphs(text);
    expect(paras.map((p) => p.text)).toEqual([
      'First para.',
      'Second para.',
      'Third.',
    ]);
    for (const { text: p, start } of paras) {
      expect(text.slice(start, start + p.length)).toBe(p);
    }
  });

  it('returns a single paragraph for text without blank lines', () => {
    expect(splitParagraphs('one\ntwo')).toEqual([{ text: 'one\ntwo', start: 0 }]);
  });
});

describe('stripTrailingWord', () => {
  it('removes the trailing command word with punctuation', () => {
    expect(stripTrailingWord('turn on the lights, go.', 'go')).toBe(
      'turn on the lights',
    );
  });

  it('only strips at the end, not mid-sentence', () => {
    expect(stripTrailingWord('go to the store', 'go')).toBe('go to the store');
  });

  it('does not strip partial-word matches', () => {
    expect(stripTrailingWord('let it goa', 'go')).toBe('let it goa');
  });

  it('returns trimmed text when word is empty', () => {
    expect(stripTrailingWord('  hello  ', '')).toBe('hello');
  });
});

describe('currentParagraphIndex', () => {
  const text = 'AAAA.\n\nBBBB.\n\nCCCC.';

  it('finds the paragraph containing the read position', () => {
    expect(currentParagraphIndex(text, 0)).toBe(0);
    expect(currentParagraphIndex(text, 8)).toBe(1);
    expect(currentParagraphIndex(text, 15)).toBe(2);
  });

  it('falls back to the last non-empty paragraph when past the end', () => {
    expect(currentParagraphIndex(text, 999)).toBe(2);
  });

  it('returns -1 for empty text', () => {
    expect(currentParagraphIndex('', 0)).toBe(-1);
  });
});
