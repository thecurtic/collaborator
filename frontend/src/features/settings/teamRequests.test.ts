import { describe, expect, it } from 'vitest';
import { toQuestion } from '@/domain/adapters';
import { toMessage } from '@/api/agents';
import { age } from './TeamRequestsPanel';

describe('merge proposals', () => {
  const raw = {
    id: 'mq-1', prompt: 'Merge integration into main for tidepool?', multiple: false, freeform: false,
    options: [{ id: 'merge', label: 'Merge' }, { id: 'not_now', label: 'Not now' }],
    proposal: { approve_option: 'merge', summary: 'Milestone: viewer', commits: 12,
                body: { v: 1, kind: 'merge', project: 'tidepool', from_sha: 'abc', to_sha: 'def' } },
  };

  it('maps the API shape to the app shape', () => {
    const q = toQuestion(raw)!;
    expect(q.proposal).toEqual({ approveOption: 'merge', summary: 'Milestone: viewer', commits: 12,
      body: raw.proposal.body });
    expect(q.options).toHaveLength(2);
  });

  it('leaves an ordinary question alone', () => {
    const { proposal: _p, ...plain } = raw;
    expect(toQuestion(plain)?.proposal).toBeUndefined();
    expect(toQuestion(null)).toBeNull();
  });

  it('carries the request on a message', () => {
    const m = toMessage({ id: 3, question: raw, request: { id: 'r-1', kind: 'merge', state: 'sending',
      message_id: 3, created_at: 'x', updated_at: 'x' } });
    expect(m.request?.state).toBe('sending');
    expect(m.question?.proposal?.approveOption).toBe('merge');
  });
});

describe('age', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  it('rounds down to the largest unit', () => {
    expect(age('2026-10-24T11:59:30Z', now)).toBe('now');
    expect(age('2026-10-24T11:55:00Z', now)).toBe('5m');
    expect(age('2026-10-24T09:00:00Z', now)).toBe('3h');
    expect(age('2026-10-21T12:00:00Z', now)).toBe('3d');
  });
});
