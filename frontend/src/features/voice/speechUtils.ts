// Slightly faster than 1.0 — neural medium voices read a touch slowly.
export const SPEECH_RATE = 1.12;

/**
 * A streaming speech session: push text (possibly token-by-token), call finish()
 * when done; `onIdle` (passed to the implementation) fires once everything has
 * been spoken. stop() cancels immediately. Implemented by Piper and Web Speech.
 */
export interface SpeechSession {
  push(chunk: string): void;
  finish(): void;
  stop(): void;
}

/**
 * Strip Markdown/markup before TTS so engines don't read symbols aloud (neither
 * Piper nor Web Speech support emphasis markup). Only affects spoken audio — the
 * on-screen text keeps its formatting.
 */
export function sanitizeForSpeech(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks → drop
      .replace(/`([^`]+)`/g, '$1') // inline code → contents
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image → alt
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // link → text
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headers
      .replace(/^\s*>\s?/gm, '') // blockquotes
      .replace(/^\s*[-*+]\s+/gm, '') // list bullets (before stripping *)
      .replace(/\*\*|\*|__|_|~~/g, '') // emphasis markers
      .replace(/\|/g, ' ') // table pipes
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/** Split off complete sentences from a buffer, returning the leftover tail. */
export function extractSentences(buffer: string): {
  sentences: string[];
  rest: string;
} {
  const re = /[^.!?]*[.!?]+["')\]]*\s/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const sentence = match[0].trim();
    if (sentence) sentences.push(sentence);
    lastIndex = re.lastIndex;
  }
  return { sentences, rest: lastIndex > 0 ? buffer.slice(lastIndex) : buffer };
}
