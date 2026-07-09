import { describe, expect, it } from 'vitest';
import type { ToolStatusEvent } from '@/api/collaborator';
import type { ToolActivity } from '@/domain/models';
import { foldToolEvent } from './toolActivity';

const start = (tool: string, query?: string): ToolStatusEvent => ({
  tool,
  label: `Searching for “${query}”…`,
  query,
  isOutcome: false,
});

const outcome = (
  tool: string,
  o: 'ok' | 'empty' | 'error',
  extra: Partial<ToolStatusEvent> = {},
): ToolStatusEvent => ({
  tool,
  label: 'done',
  outcome: o,
  isOutcome: true,
  ...extra,
});

describe('foldToolEvent', () => {
  it('appends a pending row on start, preferring the full query', () => {
    const feed = foldToolEvent([], start('web_search', 'boe governor 2026'));
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      tool: 'web_search',
      text: 'boe governor 2026',
      outcome: 'pending',
    });
  });

  it('resolves the last pending row of the same tool with a result count', () => {
    let feed = foldToolEvent([], start('web_search', 'q1'));
    feed = foldToolEvent(feed, outcome('web_search', 'ok', { count: 5 }));
    expect(feed[0]).toMatchObject({ outcome: 'ok', detail: '5 results' });
  });

  it('does not resolve rows of other tools', () => {
    let feed = foldToolEvent([], start('fetch_url', undefined));
    feed = foldToolEvent(feed, start('web_search', 'q'));
    feed = foldToolEvent(feed, outcome('web_search', 'empty'));
    expect(feed[0].outcome).toBe('pending'); // fetch_url untouched
    expect(feed[1].outcome).toBe('empty');
  });

  it('carries the error reason into the resolved row', () => {
    let feed = foldToolEvent([], start('web_search', 'q'));
    feed = foldToolEvent(
      feed,
      outcome('web_search', 'error', { error: 'no engines responded' }),
    );
    expect(feed[0]).toMatchObject({
      outcome: 'error',
      detail: 'no engines responded',
    });
  });

  it('shows an orphan outcome (no matching start) as its own row', () => {
    const feed = foldToolEvent(
      [],
      outcome('some_tool', 'error', { error: 'boom' }),
    );
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ outcome: 'error', detail: 'boom' });
  });

  it('resolves the LAST pending row when a tool ran twice', () => {
    let feed: ToolActivity[] = [];
    feed = foldToolEvent(feed, start('web_search', 'first'));
    feed = foldToolEvent(feed, outcome('web_search', 'ok', { count: 3 }));
    feed = foldToolEvent(feed, start('web_search', 'second'));
    feed = foldToolEvent(feed, outcome('web_search', 'empty'));
    expect(feed[0]).toMatchObject({ text: 'first', outcome: 'ok' });
    expect(feed[1]).toMatchObject({ text: 'second', outcome: 'empty' });
  });
});
