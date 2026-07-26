import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionStream } from './transcriptionStream';

vi.mock('@/api/collaborator', () => ({
  api: { getWsTicket: vi.fn().mockResolvedValue('ticket-1') },
}));

/** Minimal scriptable WebSocket double for the session protocol. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: (string | ArrayBuffer)[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  private listeners = new Map<string, ((e?: unknown) => void)[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (e?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  // Test hooks
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }
  serverMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  jsonSent(): unknown[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d));
  }
  private emit(type: string): void {
    this.listeners.get(type)?.forEach((fn) => fn());
  }
}

async function openStream(
  opts: ConstructorParameters<typeof TranscriptionStream>[1],
  onPartial: (t: string) => void = () => {},
) {
  const stream = new TranscriptionStream(onPartial, opts);
  const readyP = stream.ready();
  await vi.waitFor(() => {
    if (FakeWebSocket.instances.length === 0) throw new Error('no socket yet');
  });
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.serverOpen();
  await readyP;
  return { stream, ws };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TranscriptionStream session protocol', () => {
  it('sends the phrase config first, before any audio', async () => {
    const { stream, ws } = await openStream({
      phrases: [
        { kind: 'end', text: 'that is all' },
        { kind: 'interrupt', text: 'hold on' },
      ],
    });
    stream.sendPcm(new ArrayBuffer(4));
    expect(ws.jsonSent()[0]).toEqual({
      type: 'config',
      phrases: [
        { kind: 'end', text: 'that is all' },
        { kind: 'interrupt', text: 'hold on' },
      ],
      language: 'en',
    });
    expect(ws.sent[1]).toBeInstanceOf(ArrayBuffer);
  });

  it('sends no config for plain dictation sessions', async () => {
    const { ws } = await openStream({});
    expect(ws.jsonSent()).toEqual([]);
  });

  it('surfaces phrase events and skips the duplicate end message after phrase(end)', async () => {
    const kinds: string[] = [];
    const { stream, ws } = await openStream({
      phrases: [{ kind: 'end', text: 'that is all' }],
      onPhrase: (k) => kinds.push(k),
    });
    ws.serverMessage({ type: 'phrase', kind: 'end' });
    expect(kinds).toEqual(['end']);

    // The server finalizes on its own after phrase(end) — end() must not
    // send a second {"type":"end"}, just await the final.
    const finalP = stream.end();
    expect(ws.jsonSent().filter((m) => (m as { type: string }).type === 'end')).toEqual([]);
    ws.serverMessage({ type: 'final', text: 'hello world' });
    await expect(finalP).resolves.toBe('hello world');
  });

  it('interrupt phrases leave the session running and end() still finalizes manually', async () => {
    const kinds: string[] = [];
    const { stream, ws } = await openStream({
      phrases: [{ kind: 'interrupt', text: 'hold on' }],
      onPhrase: (k) => kinds.push(k),
    });
    ws.serverMessage({ type: 'phrase', kind: 'interrupt' });
    expect(kinds).toEqual(['interrupt']);

    const finalP = stream.end();
    expect(ws.jsonSent()).toContainEqual({ type: 'end' });
    ws.serverMessage({ type: 'final', text: 'still here' });
    await expect(finalP).resolves.toBe('still here');
  });

  it('resolves the final as empty when the socket closes early', async () => {
    const { stream, ws } = await openStream({});
    const finalP = stream.end();
    ws.close();
    await expect(finalP).resolves.toBe('');
  });
});
