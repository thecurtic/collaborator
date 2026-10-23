import { describe, expect, it } from 'vitest';
import type { ToolCall } from './toolLogApi';
import { argLines, fmtChars, fmtMs, groupByDay, prettyPreview, sinceFor } from './toolLogFormat';

function call(id: number, ts: string): ToolCall {
  return {
    id, ts, source: 'chat', rootId: null, turnId: null, round: 0, tool: 'calculate',
    category: 'compute', outcome: 'ok', error: null, resultChars: 2, durationMs: 1,
    model: null, args: {}, label: 'Calculating', risk: false, recovered: false,
    backfilled: false, trigger: null,
  };
}

describe('sinceFor', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  it('gives a UTC bound in the log form', () => {
    expect(sinceFor('24h', now)).toBe('2026-10-22 12:00:00');
    expect(sinceFor('7d', now)).toBe('2026-10-16 12:00:00');
  });
  it('has no bound for all', () => {
    expect(sinceFor('all', now)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats durations and sizes', () => {
    expect(fmtMs(250)).toBe('250 ms');
    expect(fmtMs(1500)).toBe('1.5 s');
    expect(fmtMs(null)).toBeNull();
    expect(fmtChars(512)).toBe('512 chars');
    expect(fmtChars(23_400)).toBe('23k chars');
  });

  it('turns arguments into readable lines', () => {
    expect(argLines({ query: 'garden', titles: ['a'], empty: '', _unparsed: '{x' })).toEqual([
      { key: 'query', value: 'garden' },
      { key: 'titles', value: '[\n  "a"\n]' },
      { key: 'unparsed arguments', value: '{x' },
    ]);
  });

  it('pretty-prints complete JSON and leaves truncated text alone', () => {
    expect(prettyPreview('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyPreview('{"a": "tru…')).toBe('{"a": "tru…');
  });
});

describe('groupByDay', () => {
  it('groups consecutive calls by local day', () => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    const earlier = new Date(now.getTime() - 60_000);
    const old = new Date(now.getTime() - 5 * 86_400_000);
    const groups = groupByDay([call(1, iso(now)), call(2, iso(earlier)), call(3, iso(old))], now);
    expect(groups[0].calls.map((c) => c.id)).toContain(1);
    expect(groups[groups.length - 1].calls.map((c) => c.id)).toEqual([3]);
  });
});
