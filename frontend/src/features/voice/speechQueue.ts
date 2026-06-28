import { synthesize } from './piperTts';
import {
  SPEECH_RATE,
  sanitizeForSpeech,
  extractSentences,
  type SpeechSession,
} from './speechUtils';

/**
 * Piper speech session. Speaks streamed text sentence-by-sentence with pipelined
 * synthesis (the next sentence is synthesized while the current one plays) so
 * there are no gaps. Markdown is stripped before synthesis.
 */
export class SpeechQueue implements SpeechSession {
  private buffer = '';
  private queue: string[] = [];
  private synthAhead: Promise<Blob | null> | null = null;
  private playing = false;
  private finished = false;
  private stopped = false;
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;

  constructor(private onIdle?: () => void) {}

  push(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    const { sentences, rest } = extractSentences(this.buffer);
    this.queue.push(...sentences);
    this.buffer = rest;
    void this.pump();
  }

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
    this.synthAhead = null;
    this.audio?.pause();
    this.cleanup();
  }

  private synth(text: string): Promise<Blob | null> {
    const clean = sanitizeForSpeech(text);
    if (!clean) return Promise.resolve(null);
    return synthesize(clean).catch(() => null);
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

    let blobPromise = this.synthAhead;
    this.synthAhead = null;
    if (!blobPromise) {
      const next = this.queue.shift();
      if (next === undefined) {
        if (this.finished) this.onIdle?.();
        return;
      }
      blobPromise = this.synth(next);
    }

    this.playing = true;
    const blob = await blobPromise;
    if (this.stopped) {
      this.playing = false;
      return;
    }

    // Pre-synthesize the following sentence while this one plays.
    const following = this.queue.shift();
    if (following !== undefined) this.synthAhead = this.synth(following);

    if (blob) await this.play(blob);
    this.playing = false;
    if (!this.stopped) void this.pump();
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      this.url = URL.createObjectURL(blob);
      const audio = new Audio(this.url);
      audio.playbackRate = SPEECH_RATE;
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
