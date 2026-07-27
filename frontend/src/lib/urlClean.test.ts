import { describe, expect, it } from 'vitest';
import { cleanUrl, cleanUrlsInText } from './urlClean';

describe('cleanUrl', () => {
  it('strips utm_* and click ids, keeping functional params', () => {
    expect(
      cleanUrl(
        'https://example.com/a?utm_source=x&utm_medium=y&id=42&fbclid=abc',
      ),
    ).toBe('https://example.com/a?id=42');
  });

  it('drops the dangling ? when every param was tracking', () => {
    expect(cleanUrl('https://example.com/a?utm_source=x')).toBe(
      'https://example.com/a',
    );
    expect(cleanUrl('https://example.com/a?gclid=1#frag')).toBe(
      'https://example.com/a#frag',
    );
  });

  it('returns clean URLs byte-for-byte unchanged', () => {
    const u = 'https://example.com/search?q=utm_source&page=2';
    expect(cleanUrl(u)).toBe(u); // "utm_source" as a VALUE is not tracking
  });

  it('leaves non-http(s) and unparseable strings alone', () => {
    expect(cleanUrl('mailto:a@b.c?utm_source=x')).toBe(
      'mailto:a@b.c?utm_source=x',
    );
    expect(cleanUrl('not a url')).toBe('not a url');
  });

  it('strips youtube/spotify share ids (si)', () => {
    expect(cleanUrl('https://youtu.be/abc123?si=SHAREID')).toBe(
      'https://youtu.be/abc123',
    );
  });
});

describe('cleanUrlsInText', () => {
  it('cleans every URL in prose, preserving trailing punctuation', () => {
    expect(
      cleanUrlsInText(
        'See https://a.com/x?utm_source=nl. Also https://b.com/?q=1&gclid=z, ok?',
      ),
    ).toBe('See https://a.com/x. Also https://b.com/?q=1, ok?');
  });

  it('leaves text without URLs untouched', () => {
    const t = 'no links here, just words';
    expect(cleanUrlsInText(t)).toBe(t);
  });
});
