import { describe, expect, it } from 'vitest';
import { preprocessWikilinks } from './NoteBody';

describe('preprocessWikilinks', () => {
  it('converts a bare wikilink', () => {
    expect(preprocessWikilinks('See [[SQLite fits]] for details')).toBe(
      'See [SQLite fits](wikilink:SQLite%20fits) for details',
    );
  });

  it('uses the alias as the label', () => {
    expect(preprocessWikilinks('[[Long Note Title|short]]')).toBe(
      '[short](wikilink:Long%20Note%20Title)',
    );
  });

  it('strips heading anchors from the target', () => {
    expect(preprocessWikilinks('[[Note#section]]')).toBe(
      '[Note#section](wikilink:Note)',
    );
  });

  it('handles multiple links and leaves plain text alone', () => {
    const out = preprocessWikilinks('a [[One]] b [[Two|2]] c');
    expect(out).toBe('a [One](wikilink:One) b [2](wikilink:Two) c');
  });

  it('leaves ordinary markdown links untouched', () => {
    const md = '[label](https://example.com) and [x][ref]';
    expect(preprocessWikilinks(md)).toBe(md);
  });
});
