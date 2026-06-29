import {
  SPEECH_RATE,
  sanitizeForSpeech,
  extractSentences,
  type SpeechSession,
} from './speechUtils';

export function webSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Prefer a local English voice; fall back to any English, then the default. */
function pickVoice(): SpeechSynthesisVoice | null {
  if (!webSpeechSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  return (
    voices.find((v) => v.lang.startsWith('en') && v.localService) ??
    voices.find((v) => v.lang.startsWith('en')) ??
    voices[0]
  );
}

/**
 * Web Speech (browser TTS) session. Speaks streamed text sentence-by-sentence
 * using SpeechSynthesisUtterance, chained one at a time so `onIdle` fires when
 * everything has been spoken. Instant (no model), quality depends on the OS.
 */
export class WebSpeechSession implements SpeechSession {
  private buffer = '';
  private queue: string[] = [];
  private speaking = false;
  private finished = false;
  private stopped = false;
  private spokenChars = 0;

  constructor(
    private onIdle?: () => void,
    private onProgress?: (chars: number) => void,
  ) {}

  push(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    const { sentences, rest } = extractSentences(this.buffer);
    this.queue.push(...sentences);
    this.buffer = rest;
    this.pump();
  }

  finish(): void {
    if (this.stopped) return;
    this.finished = true;
    const rest = this.buffer.trim();
    if (rest) this.queue.push(rest);
    this.buffer = '';
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.buffer = '';
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }

  private pump(): void {
    if (this.speaking || this.stopped) return;
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.finished) this.onIdle?.();
      return;
    }
    // This sentence is now being read — advance the read-along position.
    this.spokenChars += next.length;
    this.onProgress?.(this.spokenChars);
    const clean = sanitizeForSpeech(next);
    if (!clean) {
      this.pump();
      return;
    }
    this.speaking = true;
    const utter = new SpeechSynthesisUtterance(clean);
    utter.rate = SPEECH_RATE;
    const voice = pickVoice();
    if (voice) utter.voice = voice;
    const done = () => {
      this.speaking = false;
      if (!this.stopped) this.pump();
    };
    utter.onend = done;
    utter.onerror = done;
    window.speechSynthesis.speak(utter);
  }
}
