import { describe, expect, it } from 'vitest';
import type { ApiRecall, ApiTurn } from '@/api/types';
import { toRecallBlock, toTurn } from './adapters';

const baseTurn: ApiTurn = {
  id: 1,
  user_id: null,
  role: 'user',
  committed: 1, // SQLite-style
  context_turns: 5,
  created_at: '2026-07-04 12:00:00',
  model_name: null,
  token_count: null,
  tags: ' a, b ,, c ',
};

describe('toTurn', () => {
  it('maps the as-built single `content` column by role', () => {
    const user = toTurn({ ...baseTurn, content: 'hi' });
    expect(user.message).toBe('hi');
    expect(user.response).toBe('');

    const asst = toTurn({ ...baseTurn, role: 'assistant', content: 'hello' });
    expect(asst.message).toBe('');
    expect(asst.response).toBe('hello');
  });

  it('falls back to the API-SPEC message/response shape', () => {
    const t = toTurn({ ...baseTurn, message: 'spec-style' });
    expect(t.message).toBe('spec-style');
  });

  it('normalizes SQLite 0/1 committed to boolean', () => {
    expect(toTurn({ ...baseTurn, content: 'x' }).committed).toBe(true);
    expect(toTurn({ ...baseTurn, content: 'x', committed: 0 }).committed).toBe(
      false,
    );
  });

  it('parses the comma-joined tags string into a clean array', () => {
    expect(toTurn({ ...baseTurn, content: 'x' }).tags).toEqual(['a', 'b', 'c']);
    expect(toTurn({ ...baseTurn, content: 'x', tags: null }).tags).toEqual([]);
  });
});

describe('toRecallBlock', () => {
  it('maps a well-formed block', () => {
    const block = toRecallBlock({
      content: 'remembered',
      sources: [
        {
          turn_id: 7,
          role: 'user',
          tags: ['t'],
          branch_root_id: 3,
          similarity: 0.9,
          score: 1.2,
          preview: 'p',
        },
      ],
    });
    expect(block.content).toBe('remembered');
    expect(block.sources[0]).toEqual({
      turnId: 7,
      role: 'user',
      tags: ['t'],
      branchRootId: 3,
      similarity: 0.9,
      score: 1.2,
      preview: 'p',
    });
  });

  it('survives a malformed SSE payload with defaults', () => {
    // Simulates an unvalidated `recall` SSE event with junk fields.
    const block = toRecallBlock({
      content: 42,
      sources: [{ turn_id: 'nope', tags: 'not-an-array' }],
    } as unknown as ApiRecall);
    expect(block.content).toBe('');
    expect(block.sources[0]).toEqual({
      turnId: 0,
      role: '',
      tags: [],
      branchRootId: null,
      similarity: 0,
      score: 0,
      preview: '',
    });
  });
});
