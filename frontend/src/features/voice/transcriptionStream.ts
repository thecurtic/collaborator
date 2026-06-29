import { getPasskey } from '@/auth/session';

/**
 * Client for WS /api/transcribe/stream: send PCM16 frames, receive live partial
 * transcripts, and a final transcript after end(). Passkey goes in the query
 * string (browser WebSockets can't set headers).
 */
export class TranscriptionStream {
  private ws: WebSocket;
  private opened: Promise<void>;
  private finalPromise: Promise<string>;
  private resolveFinal!: (text: string) => void;
  private settled = false;

  constructor(onPartial: (text: string) => void, language = 'en') {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const passkey = encodeURIComponent(getPasskey() ?? '');
    const url = `${proto}://${location.host}/api/transcribe/stream?passkey=${passkey}&language=${language}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener(
        'error',
        () => reject(new Error('Transcription socket failed')),
        { once: true },
      );
    });

    this.finalPromise = new Promise((resolve) => {
      this.resolveFinal = (text: string) => {
        if (!this.settled) {
          this.settled = true;
          resolve(text);
        }
      };
    });

    this.ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const msg = JSON.parse(e.data) as { type?: string; text?: string };
        if (msg.type === 'partial') onPartial(msg.text ?? '');
        else if (msg.type === 'final') this.resolveFinal(msg.text ?? '');
        else if (msg.type === 'error') this.resolveFinal('');
      } catch {
        /* ignore malformed */
      }
    };
    // If the socket closes before a final, don't hang.
    this.ws.addEventListener('close', () => this.resolveFinal(''));
  }

  ready(): Promise<void> {
    return this.opened;
  }

  sendPcm(buf: ArrayBuffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** Signal end-of-turn; resolves with the final transcript. */
  end(): Promise<string> {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }));
    }
    return this.finalPromise;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
