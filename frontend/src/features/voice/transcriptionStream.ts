import { api } from '@/api/collaborator';

/** A voice command phrase detected server-side in the ASR transcript. */
export type PhraseKind = 'end' | 'interrupt';

export interface PhraseConfig {
  kind: PhraseKind;
  text: string;
}

export interface TranscriptionStreamOptions {
  language?: string;
  /**
   * Phrases the server should detect in-stream (9acc3d1): tail-of-transcript
   * match + ~350 ms silence gate. `end` → the server finalizes on its own
   * (phrase event, then a `final` with the phrase stripped, then close);
   * `interrupt` → event only, the session keeps running.
   */
  phrases?: PhraseConfig[];
  onPhrase?: (kind: PhraseKind) => void;
}

/**
 * Client for WS /api/transcribe/stream: send PCM16 frames, receive live partial
 * transcripts, optional server-detected phrase events, and a final transcript.
 *
 * Auth: a short-lived single-use ticket (POST /api/auth/ws-ticket) fetched in
 * ready(), right before the socket opens. Ticket-only — the backend removed
 * the passkey-in-URL path (3275100), so a failed ticket fetch fails ready()
 * (surfaced as a retryable error upstream).
 */
export class TranscriptionStream {
  private ws: WebSocket | null = null;
  private opened: Promise<void> | null = null;
  private finalPromise: Promise<string>;
  private resolveFinal!: (text: string) => void;
  private settled = false;
  private closed = false;
  // Server-side finalize is already underway (end phrase fired) — end() must
  // not send a second {"type":"end"}.
  private serverFinalizing = false;

  constructor(
    private onPartial: (text: string) => void,
    private options: TranscriptionStreamOptions = {},
  ) {
    this.finalPromise = new Promise((resolve) => {
      this.resolveFinal = (text: string) => {
        if (!this.settled) {
          this.settled = true;
          resolve(text);
        }
      };
    });
  }

  /** Fetch an auth ticket and open the socket; resolves once it's connected. */
  ready(): Promise<void> {
    if (!this.opened) this.opened = this.open();
    return this.opened;
  }

  private async open(): Promise<void> {
    const auth = `ticket=${encodeURIComponent(await api.getWsTicket())}`;
    if (this.closed) return; // close() raced the ticket fetch

    const language = this.options.language ?? 'en';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/api/transcribe/stream?${auth}&language=${language}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const msg = JSON.parse(e.data) as {
          type?: string;
          text?: string;
          kind?: string;
        };
        if (msg.type === 'partial') this.onPartial(msg.text ?? '');
        else if (msg.type === 'final') this.resolveFinal(msg.text ?? '');
        else if (msg.type === 'error') this.resolveFinal('');
        else if (msg.type === 'phrase') {
          const kind = msg.kind === 'end' ? 'end' : 'interrupt';
          // After phrase(end) the server sends final + closes by itself.
          if (kind === 'end') this.serverFinalizing = true;
          this.options.onPhrase?.(kind);
        }
      } catch {
        /* ignore malformed */
      }
    };
    // If the socket closes before a final, don't hang.
    ws.addEventListener('close', () => this.resolveFinal(''));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener(
        'error',
        () => reject(new Error('Transcription socket failed')),
        { once: true },
      );
    });

    // Session config (phrases) goes out first, before any audio.
    const phrases = this.options.phrases;
    if (phrases?.length && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'config', phrases, language }));
    }
  }

  sendPcm(buf: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** Signal end-of-turn; resolves with the final transcript. */
  end(): Promise<string> {
    if (!this.serverFinalizing && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }));
    }
    return this.finalPromise;
  }

  close(): void {
    this.closed = true;
    this.resolveFinal('');
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
