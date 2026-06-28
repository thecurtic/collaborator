import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { SpeechQueue } from './speechQueue';

export type CallPhase = 'connecting' | 'listening' | 'responding' | 'error';

// How often we transcribe the audio-so-far to look for the end phrase.
const DETECT_INTERVAL_MS = 2200;
// Safety: auto-finish a turn that runs too long (in case the phrase is missed).
const MAX_UTTERANCE_MS = 30000;
const DEFAULT_END_PHRASE = 'go ahead';

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? '';
}

function extFor(mime: string): string {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

function containsPhrase(text: string, phrase: string): boolean {
  return !!phrase && text.toLowerCase().includes(phrase.toLowerCase());
}

function stripPhrase(text: string, phrase: string): string {
  if (!phrase) return text.trim();
  const lower = text.toLowerCase();
  const p = phrase.toLowerCase();
  const idx = lower.lastIndexOf(p);
  if (idx === -1) return text.trim();
  return (text.slice(0, idx) + text.slice(idx + p.length)).trim();
}

interface Controls {
  endTurn: () => void;
  end: () => void;
}

/**
 * Drives the call loop: listen → (chunked transcription detects the end phrase,
 * or a manual "done" / max-duration) → stream the reply (live tokens) → speak it
 * via Piper sentence-by-sentence → back to listening.
 */
export function useCall(open: boolean, onClose: () => void) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
  const [partial, setPartial] = useState(''); // user's in-progress transcript
  const [response, setResponse] = useState(''); // assistant streaming text
  const [error, setError] = useState<string | null>(null);
  const controlsRef = useRef<Controls | null>(null);

  useEffect(() => {
    if (!open) return;

    let active = true;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let mime = '';
    let detectTimer: number | undefined;
    let maxTimer: number | undefined;
    let transcribing = false;
    let finalizing = false;
    let endPhrase = DEFAULT_END_PHRASE;
    let queue: SpeechQueue | null = null;
    let latest = '';

    const clearTimers = () => {
      if (detectTimer) window.clearInterval(detectTimer);
      if (maxTimer) window.clearTimeout(maxTimer);
      detectTimer = maxTimer = undefined;
    };

    const stopRecorder = () => {
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      recorder = null;
    };

    const cleanup = () => {
      active = false;
      clearTimers();
      stopRecorder();
      queue?.stop();
      queue = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const cumulativeBlob = () =>
      new Blob(chunks, { type: mime || 'audio/webm' });

    const startListening = () => {
      if (!active || !stream) return;
      chunks = [];
      latest = '';
      finalizing = false;
      setPartial('');
      setResponse('');
      try {
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        recorder.start(1000); // timeslice so chunks accumulate into a valid blob
      } catch {
        setPhase('error');
        setError('Could not start recording.');
        return;
      }
      setPhase('listening');
      detectTimer = window.setInterval(() => void detect(), DETECT_INTERVAL_MS);
      maxTimer = window.setTimeout(() => void finalize(true), MAX_UTTERANCE_MS);
    };

    const detect = async () => {
      if (!active || transcribing || finalizing || chunks.length === 0) return;
      transcribing = true;
      try {
        const text = await api.transcribe(cumulativeBlob(), {
          filename: `call.${extFor(mime)}`,
        });
        if (!active || finalizing) return;
        latest = text;
        setPartial(text);
        if (containsPhrase(text, endPhrase)) await finalize(false);
      } catch {
        /* ignore a failed poll; we'll try again next tick */
      } finally {
        transcribing = false;
      }
    };

    const finalize = async (forceTranscribe: boolean) => {
      if (!active || finalizing) return;
      finalizing = true;
      clearTimers();
      stopRecorder();
      // Let the final ondataavailable land before reading the blob.
      await new Promise((r) => setTimeout(r, 150));

      let text = latest;
      if (forceTranscribe || !text) {
        try {
          text = await api.transcribe(cumulativeBlob(), {
            filename: `call.${extFor(mime)}`,
          });
        } catch {
          /* keep whatever we had */
        }
      }
      if (!active) return;
      const clean = stripPhrase(text, endPhrase);
      if (!clean) {
        startListening(); // nothing intelligible; keep listening
        return;
      }
      await respond(clean);
    };

    const respond = async (text: string) => {
      setPhase('responding');
      setPartial(text);
      setResponse('');
      queue = new SpeechQueue(() => {
        if (active) startListening();
      });
      try {
        await api.sendMessageStream({ message: text, commit: true }, (c) => {
          setResponse((prev) => prev + c);
          queue?.push(c);
        });
        queue?.finish();
      } catch (err) {
        if (!active) return;
        queue?.stop();
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setPhase('error');
      }
    };

    controlsRef.current = {
      endTurn: () => void finalize(true),
      end: () => {
        cleanup();
        onClose();
      },
    };

    void (async () => {
      try {
        try {
          const s = await api.getSettings();
          endPhrase = s.voiceEndPhrase || DEFAULT_END_PHRASE;
        } catch {
          /* fall back to default phrase */
        }
        if (!active) return;
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone not supported in this browser.');
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        mime = pickMimeType();
        startListening();
      } catch (err) {
        if (!active) return;
        setPhase('error');
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Microphone permission denied.'
            : err instanceof Error
              ? err.message
              : 'Could not start the call.',
        );
      }
    })();

    return () => cleanup();
  }, [open, onClose]);

  const endTurn = useCallback(() => controlsRef.current?.endTurn(), []);
  const end = useCallback(() => controlsRef.current?.end(), []);

  return { phase, partial, response, error, endTurn, end };
}
