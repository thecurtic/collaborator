import { describe, expect, it } from 'vitest';
import type { ApiRecall, ApiTurn } from '@/api/types';
import { toHealth, toNoteDraft, toRecallBlock, toTurn } from './adapters';

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

describe('toNoteDraft event fields', () => {
  const base = {
    id: 1,
    run_id: 'r',
    tree_root_id: null,
    title: 'T',
    body: 'B',
    status: 'pending' as const,
    created_at: '2026-07-27 12:00:00',
    decided_at: null,
  };

  it('maps real event fields', () => {
    const d = toNoteDraft({
      ...base,
      fields: { start: '2026-08-02T14:00', end: null, all_day: false },
    });
    expect(d.fields).toMatchObject({
      start: '2026-08-02T14:00',
      end: null,
      allDay: false,
    });
  });

  it('maps goal fields (state/due) through the shared superset', () => {
    const d = toNoteDraft({
      ...base,
      fields: { state: 'started', due: '2026-08-15' },
    });
    expect(d.fields).toMatchObject({ state: 'started', due: '2026-08-15' });
  });

  it('treats the backend\'s empty fields column as "not an event"', () => {
    expect(toNoteDraft({ ...base, fields: {} }).fields).toBeNull();
    expect(
      toNoteDraft({
        ...base,
        fields: { start: null, end: null, all_day: false },
      }).fields,
    ).toBeNull();
    expect(toNoteDraft({ ...base }).fields).toBeNull();
  });
});

describe('toHealth capabilities', () => {
  it('defaults to all-false when the backend does not advertise them', () => {
    expect(toHealth({ status: 'healthy', version: '0.3.0' }).capabilities).toEqual({
      sttStream: false,
      ttsStream: false,
      phrases: false,
    });
  });

  it('maps advertised flags and tolerates 0/1 serialization', () => {
    const h = toHealth({
      status: 'healthy',
      version: '0.4.0',
      capabilities: {
        stt_stream: true,
        tts_stream: 1 as unknown as boolean, // SQLite-style truthiness
        phrases: 0 as unknown as boolean,
      },
    });
    expect(h.capabilities).toEqual({
      sttStream: true,
      ttsStream: true,
      phrases: false,
    });
  });
});
