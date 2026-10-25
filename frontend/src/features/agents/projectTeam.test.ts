import { describe, expect, it } from 'vitest';
import { toTeam } from '@/api/agents';
import { inferProjects, nameFor } from '@/features/projects/projectInference';
import { formatCost, formatTokens } from './ProjectTeam';
import { firstLine, NAME_RE } from './StartAgentsSheet';

describe('starting agents from a note', () => {
  it('takes the first line of prose as the description', () => {
    expect(firstLine('# Tidepool\n\nA **viewer** for [[Reef|reefs]].\nMore.')).toBe('A viewer for reefs.');
    expect(firstLine('# Only a heading')).toBe('Only a heading');
    expect(firstLine('---\n\n- count the corals\n')).toBe('count the corals');
    expect(firstLine('')).toBe('');
    expect(firstLine('x'.repeat(200))).toHaveLength(140);
  });

  it('checks the tag can be a repo name', () => {
    expect(NAME_RE.test('tic-tac-toe')).toBe(true);
    expect(NAME_RE.test('Tic Tac')).toBe(false);
    expect(NAME_RE.test('-x')).toBe(false);
  });

  it('names a note\'s project exactly as the Projects view places it', () => {
    const items = [
      { key: 'note:a', tags: ['project', 'reef', 'bug'] },
      { key: 'note:b', tags: ['project', 'reef'] },
      { key: 'note:c', tags: ['project', 'kelp', 'bug'] },
      { key: 'note:d', tags: ['project'] },
    ];
    const inf = inferProjects(items);
    expect(nameFor('note:a', inf)).toBe('reef');
    expect(nameFor('note:c', inf)).toBe('kelp');
    expect(nameFor('note:d', inf)).toBeNull();
    expect(nameFor('note:zzz', inf)).toBeNull();
  });
});

describe('the team strip', () => {
  it('maps the team summary', () => {
    const t = toTeam({
      project: 'reef', served: true, start: 'ok',
      start_request: { id: 'r-1', kind: 'create_project', project: 'reef', state: 'done',
                       created_at: 'x', updated_at: 'x', note_title: 'Reef survey' },
      questions: [{ id: 4, endpoint_id: 'ep', project: 'reef', channel: 'pm', label: 'pm-reef',
                    text: 'Test build: http://h:1/', question: { id: 'q', prompt: 'Merge?',
                    options: [{ id: 'merge', label: 'Merge' }] }, question_state: 'open' }],
      last_merge: { text: 'Spec 3', at: '2026-10-25T10:00:00Z' },
      usage: { input: 1000, output: 200, cache_read: 5000, calls: 3, cost: 0.0312, roles: 2 },
    });
    expect(t.startRequest?.noteTitle).toBe('Reef survey');
    expect(t.questions[0].label).toBe('pm-reef');
    expect(t.usage?.cacheRead).toBe(5000);
    expect(toTeam({ project: 'x' }).usage).toBeNull();
  });

  it('formats cost and tokens', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0312)).toBe('$0.031');
    expect(formatCost(12.5)).toBe('$12.50');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(2_430_000)).toBe('2.4M');
  });
});
