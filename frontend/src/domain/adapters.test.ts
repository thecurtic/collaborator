import { describe, expect, it } from 'vitest';
import type { ApiNoteFields, ApiRecall, ApiTurn } from '@/api/types';
import {
  toChatCard,
  toFeed,
  toHealth,
  toNotificationSettings,
  toNoteDraft,
  toNoteMeta,
  toRecallBlock,
  toTranscript,
  toTreeNode,
  toTurn,
} from './adapters';

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

  it('ignores state/due left on a draft from before 2026-10-12', () => {
    const d = toNoteDraft({
      ...base,
      fields: { state: 'started', due: '2026-08-15' } as ApiNoteFields,
    });
    expect(d.fields).toBeNull();
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

describe('toNoteMeta event fields', () => {
  it('merges top-level event_* columns into NoteFields (calendar bug)', () => {
    const m = toNoteMeta({
      filename: 'Dentist.md',
      title: 'Dentist',
      tags: ['event'],
      event_start: '2026-08-11T09:00-06:00',
      event_end: null,
      event_all_day: false,
      fields: { location: 'Boulder' }, // backend fields NEVER carry times
    });
    expect(m.fields).toMatchObject({
      start: '2026-08-11T09:00-06:00',
      allDay: false,
      location: 'Boulder',
    });
  });

  it('still collapses plain notes to null fields', () => {
    const m = toNoteMeta({ filename: 'a.md', title: 'a', fields: {} });
    expect(m.fields).toBeNull();
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

describe('chat tags and the chat card', () => {
  const apiNode = {
    id: 3,
    role: 'user' as const,
    content: 'hi',
    preview: 'hi',
    parent_turn_id: null,
    children: [],
  };

  it('maps chat_tags onto tree roots, defaulting to none', () => {
    expect(
      toTreeNode({ ...apiNode, chat_tags: ['project', 'garden'] } as never)
        .chatTags,
    ).toEqual(['project', 'garden']);
    expect(toTreeNode(apiNode as never).chatTags).toEqual([]);
  });

  it('maps the card, summary optional', () => {
    expect(toChatCard({ root_id: 3, tags: ['garden'], summary: null })).toEqual(
      { rootId: 3, tags: ['garden'], summary: null },
    );
    expect(
      toChatCard({
        root_id: 3,
        tags: [],
        summary: {
          text: 'Beds planned.',
          proposed_tags: ['soil'],
          turns: 4,
          generated_at: '2026-10-12T21:00:00+00:00',
          stale: true,
        },
      }).summary,
    ).toEqual({
      text: 'Beds planned.',
      proposedTags: ['soil'],
      generatedAt: '2026-10-12T21:00:00+00:00',
      stale: true,
    });
  });
});

describe('toTranscript', () => {
  it('maps channel, error and snippet, tolerating their absence', () => {
    const base = {
      id: 7,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      status: 'error' as const,
      created_at: '2026-10-12 21:00:00',
    };
    expect(
      toTranscript({ ...base, channel: 'Garden Answers', error: 'Private video',
                     snippet: 'compost' }),
    ).toMatchObject({ channel: 'Garden Answers', error: 'Private video',
                      snippet: 'compost' });
    expect(toTranscript(base)).toMatchObject({
      channel: null,
      error: null,
      snippet: null,
    });
  });
});

describe('toNotificationSettings', () => {
  it('maps kinds and the delivery flag', () => {
    expect(
      toNotificationSettings({
        kinds: [
          { kind: 'transcript_ready', label: 'Transcript ready',
            description: 'd', default: true, enabled: false },
        ],
        delivery: { ntfy: true },
      }),
    ).toEqual({
      kinds: [{ kind: 'transcript_ready', label: 'Transcript ready',
                description: 'd', enabled: false }],
      ntfyConfigured: true,
    });
  });
});

describe('toFeed', () => {
  it('maps items and refs; unknown types fall back to note', () => {
    const f = toFeed({
      pinned: [{ key: 'chat:3', type: 'chat', title: 'Beds', warmth: null,
                 pinned: true, ref: { root_id: 3, leaf_id: 9 } }],
      items: [{ key: 'transcript:7', type: 'transcript', title: 'T',
                warmth: '2026-10-13T09:00:00.000000Z',
                ref: { transcript_id: 7, status: 'done' } },
              { key: 'x:1', type: 'mystery' as never, title: 'X', warmth: null }],
    });
    expect(f.pinned[0]).toMatchObject({ pinned: true, ref: { rootId: 3, leafId: 9 } });
    expect(f.items[0].ref.transcriptId).toBe(7);
    expect(f.items[1].type).toBe('note');
  });
});
