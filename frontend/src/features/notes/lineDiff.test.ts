import { describe, expect, it } from 'vitest';
import { lineDiff } from './lineDiff';

describe('lineDiff', () => {
  it('marks identical text as all-same', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('detects a changed line as del + add', () => {
    const d = lineDiff('keep\nold line\nkeep2', 'keep\nnew line\nkeep2');
    expect(d.map((l) => l.type)).toEqual(['same', 'del', 'add', 'same']);
    expect(d[1].text).toBe('old line');
    expect(d[2].text).toBe('new line');
  });

  it('detects pure additions and deletions', () => {
    expect(lineDiff('a', 'a\nb').map((l) => l.type)).toEqual(['same', 'add']);
    expect(lineDiff('a\nb', 'b').map((l) => l.type)).toEqual(['del', 'same']);
  });

  it('round-trips: same+del reconstruct a, same+add reconstruct b', () => {
    const a = 'one\ntwo\nthree\nfour';
    const b = 'one\n2\nthree\nfour\nfive';
    const d = lineDiff(a, b);
    const left = d.filter((l) => l.type !== 'add').map((l) => l.text);
    const right = d.filter((l) => l.type !== 'del').map((l) => l.text);
    expect(left.join('\n')).toBe(a);
    expect(right.join('\n')).toBe(b);
  });
});
