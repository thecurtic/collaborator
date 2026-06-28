import { synthesize } from './piperTts';

/**
 * Speaks streamed text sentence-by-sentence so the assistant can start talking
 * before the full response arrives. Feed tokens with push(); call finish() when
 * the stream ends. `onIdle` fires once everything queued has been spoken AND the
 * stream is finished. Synthesis + playback run strictly in order.
 */
export class SpeechQueue {
  private buffer = '';
  private queue: string[] = [];
  private playing = false;
  private finished = false;
  private stopped = false;
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;

  constructor(private onIdle?: () => void) {}

  push(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    this.drainSentences();
    void this.pump();
  }

  /** No more text is coming; flush the remainder and let the queue drain. */
  finish(): void {
    if (this.stopped) return;
    this.finished = true;
    const rest = this.buffer.trim();
    if (rest) this.queue.push(rest);
    this.buffer = '';
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.buffer = '';
    this.audio?.pause();
    this.cleanup();
  }

  /** Move complete sentences from the buffer into the play queue. */
  private drainSentences(): void {
    const re = /[^.!?]*[.!?]+["')\]]*\s/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.buffer)) !== null) {
      const sentence = match[0].trim();
      if (sentence) this.queue.push(sentence);
      lastIndex = re.lastIndex;
    }
    if (lastIndex > 0) this.buffer = this.buffer.slice(lastIndex);
  }

  private cleanup(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.audio = null;
  }

  private async pump(): Promise<void> {
    if (this.playing || this.stopped) return;
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.finished) this.onIdle?.();
      return;
    }
    this.playing = true;
    try {
      const blob = await synthesize(next);
      if (!this.stopped) await this.play(blob);
    } catch {
      // Skip a sentence that failed to synthesize/play.
    } finally {
      this.playing = false;
      if (!this.stopped) void this.pump();
    }
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      this.url = URL.createObjectURL(blob);
      const audio = new Audio(this.url);
      this.audio = audio;
      const done = () => {
        this.cleanup();
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      void audio.play().catch(() => resolve());
    });
  }
}
