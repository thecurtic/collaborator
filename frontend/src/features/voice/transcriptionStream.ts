import { api } from '@/api/collaborator';
import { getPasskey } from '@/auth/session';

/**
 * Client for WS /api/transcribe/stream: send PCM16 frames, receive live partial
 * transcripts, and a final transcript after end().
 *
 * Auth: a short-lived single-use ticket (POST /api/auth/ws-ticket) fetched in
 * ready(), right before the socket opens — the long-lived passkey never goes
 * in the URL. If the ticket fetch fails, we fall back to the deprecated
 * ?passkey= param so a transient hiccup doesn't kill the call.
 */
export class TranscriptionStream {
  private ws: WebSocket | null = null;
  private opened: Promise<void> | null = null;
  private finalPromise: Promise<string>;
  private resolveFinal!: (text: string) => void;
  private settled = false;
  private closed = false;

  constructor(
    private onPartial: (text: string) => void,
    private language = 'en',
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
    let auth: string;
    try {
      auth = `ticket=${encodeURIComponent(await api.getWsTicket())}`;
    } catch {
      // Ticket endpoint unavailable — deprecated passkey-in-URL fallback.
      auth = `passkey=${encodeURIComponent(getPasskey() ?? '')}`;
    }
    if (this.closed) return; // close() raced the ticket fetch

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/api/transcribe/stream?${auth}&language=${this.language}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const msg = JSON.parse(e.data) as { type?: string; text?: string };
        if (msg.type === 'partial') this.onPartial(msg.text ?? '');
        else if (msg.type === 'final') this.resolveFinal(msg.text ?? '');
        else if (msg.type === 'error') this.resolveFinal('');
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
  }

  sendPcm(buf: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** Signal end-of-turn; resolves with the final transcript. */
  end(): Promise<string> {
    if (this.ws?.readyState === WebSocket.OPEN) {
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
