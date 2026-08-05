import { synthesize } from './piperTts';
import {
  SPEECH_RATE,
  sanitizeForSpeech,
  extractSentences,
  type SpeechSession,
} from './speechUtils';

interface SynthResult {
  blob: Blob | null;
  /** True when synthesis errored (vs. nothing speakable after sanitizing). */
  failed: boolean;
}

interface Item {
  promise: Promise<SynthResult>;
  text: string;
}

/** Synthesize sanitized text to a playable audio blob. */
export type SynthFn = (text: string) => Promise<Blob>;

/**
 * Blob-playback speech session. Speaks streamed text sentence-by-sentence with
 * pipelined synthesis (the next sentence is synthesized while the current one
 * plays) so there are no gaps. Markdown is stripped before synthesis.
 * `onProgress` reports the cumulative count of original characters spoken (for
 * read-along); `onFailed` reports the [start, end) original-char range of a
 * sentence that could not be synthesized.
 *
 * Synthesis defaults to in-browser Piper (vits-web); pass `synthFn` to swap
 * the backend (server /api/tts) while keeping the queue/playback behavior.
 */
export class SpeechQueue implements SpeechSession {
  private buffer = '';
  private queue: string[] = [];
  private synthAhead: Item | null = null;
  private playing = false;
  private finished = false;
  private stopped = false;
  private spokenChars = 0;
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  // Fast first chunk: until something has been flushed, an early clause
  // break (or a short timeout) gets voice out without waiting for the
  // model's first full sentence — the biggest lever on time-to-first-audio.
  private flushedAny = false;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onIdle?: () => void,
    private onProgress?: (chars: number) => void,
    private onFailed?: (start: number, end: number) => void,
    private synthFn: SynthFn = synthesize,
  ) {}

  push(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    const { sentences, rest } = extractSentences(this.buffer);
    if (sentences.length > 0) {
      this.markFlushed();
      this.queue.push(...sentences);
      this.buffer = rest;
      void this.pump();
      return;
    }
    if (!this.flushedAny) this.tryEarlyFirstFlush();
  }

  finish(): void {
    if (this.stopped) return;
    this.finished = true;
    this.clearFirstTimer();
    // Push the raw (untrimmed) tail so read-along char counts stay exact.
    if (this.buffer.trim()) this.queue.push(this.buffer);
    this.buffer = '';
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.clearFirstTimer();
    this.queue = [];
    this.buffer = '';
    this.synthAhead = null;
    this.audio?.pause();
    this.cleanup();
  }

  private markFlushed(): void {
    this.flushedAny = true;
    this.clearFirstTimer();
  }

  private clearFirstTimer(): void {
    if (this.firstTimer) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
  }

  /**
   * First chunk only: flush at a clause break (comma/semicolon/colon/dash)
   * once ~8 words are in, or flush whatever is buffered after ~1.2s without
   * any boundary. Chunks stay VERBATIM contiguous slices, so read-along
   * offsets remain exact; later chunks use real sentence boundaries.
   */
  private tryEarlyFirstFlush(): void {
    const clause = /[,;:—–]["')\]]*\s+/g;
    while (clause.exec(this.buffer) !== null) {
      const cut = clause.lastIndex;
      const words = this.buffer.slice(0, cut).trim().split(/\s+/).length;
      if (words >= 8) {
        this.markFlushed();
        this.queue.push(this.buffer.slice(0, cut));
        this.buffer = this.buffer.slice(cut);
        void this.pump();
        return;
      }
    }
    if (!this.firstTimer) {
      this.firstTimer = setTimeout(() => {
        this.firstTimer = null;
        if (this.stopped || this.flushedAny) return;
        // Too short to speak naturally — wait for more text instead.
        if (this.buffer.trim().length < 15) return;
        this.markFlushed();
        this.queue.push(this.buffer);
        this.buffer = '';
        void this.pump();
      }, 1200);
    }
  }

  private synth(text: string): Promise<SynthResult> {
    const clean = sanitizeForSpeech(text);
    if (!clean) return Promise.resolve({ blob: null, failed: false });
    return this.synthFn(clean).then(
      (blob) => ({ blob, failed: false }),
      () => ({ blob: null, failed: true }),
    );
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

    let item = this.synthAhead;
    this.synthAhead = null;
    if (!item) {
      const next = this.queue.shift();
      if (next === undefined) {
        if (this.finished) this.onIdle?.();
        return;
      }
      item = { promise: this.synth(next), text: next };
    }

    this.playing = true;
    const { blob, failed } = await item.promise;
    if (this.stopped) {
      this.playing = false;
      return;
    }

    // This sentence is now being read — advance the read-along position.
    // Sentences are verbatim slices, so raw lengths map 1:1 to original text.
    this.spokenChars += item.text.length;
    this.onProgress?.(this.spokenChars);
    if (failed) {
      this.onFailed?.(this.spokenChars - item.text.length, this.spokenChars);
    }

    // Pre-synthesize the following sentence while this one plays.
    const following = this.queue.shift();
    if (following !== undefined) {
      this.synthAhead = { promise: this.synth(following), text: following };
    }

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
