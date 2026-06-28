import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { SpeechQueue } from './speechQueue';

export type CallPhase = 'connecting' | 'listening' | 'responding' | 'error';

// How often we transcribe the audio-so-far to look for the end phrase.
const POLL_MS = 2500;
// Safety cap so a turn can't run forever if the phrase is never recognized.
const MAX_UTTERANCE_MS = 60000;
const FINAL_CHUNK_WAIT = 200;
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
 * Call loop: record continuously while polling transcription for the configurable
 * end phrase (e.g. "go ahead"). End the turn on the phrase, the "Done" button, or
 * a max-duration safety — then stream the reply (live tokens) and speak it via
 * Piper sentence by sentence, then listen again. (No silence detection.)
 */
export function useCall(open: boolean, onClose: () => void) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
  const [partial, setPartial] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const controlsRef = useRef<Controls | null>(null);

  useEffect(() => {
    if (!open) return;

    let active = true;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let mime = '';
    let baseType = 'audio/webm';
    let endPhrase = DEFAULT_END_PHRASE;
    let queue: SpeechQueue | null = null;
    let pollTimer: number | undefined;
    let maxTimer: number | undefined;
    let transcribing = false;
    let finalizing = false;
    let latest = '';

    const log = (m: string) => {
      const t = new Date().toLocaleTimeString([], { hour12: false });
      setLogs((prev) => [...prev.slice(-13), `${t} ${m}`]);
    };

    const clearTimers = () => {
      if (pollTimer) window.clearInterval(pollTimer);
      if (maxTimer) window.clearTimeout(maxTimer);
      pollTimer = maxTimer = undefined;
    };

    const stopRecorder = () => {
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
    };

    const cleanup = () => {
      active = false;
      clearTimers();
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      recorder = null;
      queue?.stop();
      queue = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const cumulativeBlob = () =>
      new Blob(chunks, { type: (mime || 'audio/webm').split(';')[0] });

    const listen = () => {
      if (!active || !stream) return;
      finalizing = false;
      chunks = [];
      latest = '';
      setPhase('listening');
      setPartial('');
      setResponse('');
      try {
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch {
        setPhase('error');
        setError('Could not start recording.');
        return;
      }
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.start(1000); // timeslice so chunks accumulate into a valid blob
      pollTimer = window.setInterval(() => void poll(), POLL_MS);
      maxTimer = window.setTimeout(() => {
        log('max duration → finish');
        void finalize(true);
      }, MAX_UTTERANCE_MS);
    };

    const poll = async () => {
      if (!active || transcribing || finalizing || chunks.length === 0) return;
      transcribing = true;
      try {
        const text = await api.transcribe(cumulativeBlob(), {
          filename: `turn.${extFor(baseType)}`,
        });
        if (!active || finalizing) return;
        latest = text;
        log(`heard(${text.trim().length}): "${text.trim().slice(0, 40)}"`);
        if (text.trim()) setPartial(stripPhrase(text, endPhrase));
        if (containsPhrase(text, endPhrase)) {
          log('phrase matched → finish');
          await finalize(false);
        }
      } catch (e) {
        log(`transcribe FAIL: ${e instanceof Error ? e.message : e}`);
      } finally {
        transcribing = false;
      }
    };

    const finalize = async (forceTranscribe: boolean) => {
      if (!active || finalizing) return;
      finalizing = true;
      clearTimers();
      stopRecorder();
      await new Promise((r) => setTimeout(r, FINAL_CHUNK_WAIT));

      let text = latest;
      if (forceTranscribe || !text.trim()) {
        try {
          text = await api.transcribe(cumulativeBlob(), {
            filename: `turn.${extFor(baseType)}`,
          });
        } catch (e) {
          log(`final transcribe FAIL: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (!active) return;
      const clean = stripPhrase(text, endPhrase);
      log(`finalize → "${clean.slice(0, 40)}"`);
      if (clean) {
        await respond(clean);
      } else {
        listen(); // nothing intelligible — listen again
      }
    };

    const respond = async (text: string) => {
      if (!active) return;
      log(`responding to: "${text.slice(0, 40)}"`);
      setPhase('responding');
      setPartial(text);
      setResponse('');
      queue = new SpeechQueue(() => {
        if (active) listen();
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
      endTurn: () => {
        log('Done tapped');
        void finalize(true);
      },
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
          /* keep default */
        }
        log(`phrase="${endPhrase}"`);
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
        baseType = (mime || 'audio/webm').split(';')[0];
        log(`mic ok, mime=${baseType}`);
        listen();
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

  return { phase, partial, response, error, logs, endTurn, end };
}
