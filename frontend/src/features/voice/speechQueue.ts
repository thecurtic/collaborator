import { synthesize } from './piperTts';

// Slightly faster than 1.0 — Piper medium voices read a touch slowly.
const SPEECH_RATE = 1.12;

/**
 * Speaks streamed text sentence-by-sentence. Synthesis is pipelined: the next
 * sentence is synthesized while the current one plays, so there are no audible
 * gaps between sentences. Feed tokens with push(); call finish() when the stream
 * ends; `onIdle` fires once everything has been spoken.
 */
export class SpeechQueue {
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
    this.drainSentences();
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

  private synth(text: string): Promise<Blob | null> {
    return synthesize(text).catch(() => null);
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

    // Next blob: either one we pre-synthesized, or synthesize on demand.
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

    // Start synthesizing the following sentence while this one plays.
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
