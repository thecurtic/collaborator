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

export interface Paragraph {
  text: string;
  /** Character offset of this paragraph's start within the original text. */
  start: number;
}

/**
 * Split text into paragraphs on blank lines, keeping each paragraph's character
 * offset so read-along and tap-to-skip can map a paragraph index ↔ char offset
 * consistently. Indices match `text.split(/\n{2,}/)`.
 */
export function splitParagraphs(text: string): Paragraph[] {
  const re = /\n{2,}/g;
  const out: Paragraph[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(last, m.index), start: last });
    last = m.index + m[0].length;
  }
  out.push({ text: text.slice(last), start: last });
  return out;
}

/**
 * Split off complete sentences from a buffer, returning the leftover tail.
 *
 * Sentences are VERBATIM contiguous slices of the input (whitespace included):
 * every character lands in exactly one sentence or in `rest`, so summing
 * sentence lengths gives exact read-along offsets into the original text.
 * (A previous version collected regex matches instead — text between a failed
 * match and the next match start, e.g. before "**bold.**", was silently
 * dropped from speech.)
 */
export function extractSentences(buffer: string): {
  sentences: string[];
  rest: string;
} {
  // Boundary = sentence punctuation, optional closing quotes/brackets/markdown
  // markers, then whitespace.
  const re = /[.!?]+["')\]*_~]*\s+/g;
  const sentences: string[] = [];
  let last = 0;
  while (re.exec(buffer) !== null) {
    sentences.push(buffer.slice(last, re.lastIndex));
    last = re.lastIndex;
  }
  return { sentences, rest: buffer.slice(last) };
}

/** Strip a trailing command word (e.g. the spoken "go") from a transcript. */
export function stripTrailingWord(text: string, word: string): string {
  const t = text.trim();
  if (!word) return t;
  const re = new RegExp(`[\\s,.!?]*\\b${word}\\b[\\s,.!?]*$`, 'i');
  return t.replace(re, '').trim();
}

/**
 * Index of the paragraph containing the read-along position `readChars`
 * (falls back to the last non-empty paragraph); -1 for empty text.
 */
export function currentParagraphIndex(text: string, readChars: number): number {
  const paras = splitParagraphs(text);
  const idx = paras.findIndex(
    ({ text: p, start }) =>
      p.trim() !== '' && readChars >= start && readChars < start + p.length,
  );
  if (idx !== -1) return idx;
  for (let i = paras.length - 1; i >= 0; i--) {
    if (paras[i].text.trim()) return i;
  }
  return -1;
}
