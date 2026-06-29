import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { getEndWord, getStopWord } from '@/features/settings/uiPrefs';
import { chimeListenStart, chimeListenStop } from './chime';
import { listenForWords, warmUpKeywordSpotter } from './keywordSpotter';
import { createSpeechSession, type SpeechSession } from './speech';

export type CallPhase =
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'responding'
  | 'error';

const MAX_UTTERANCE_MS = 60000; // safety cap on a single turn

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

/** Strip a trailing command word (e.g. the spoken "go") from the transcript. */
function stripTrailingWord(text: string, word: string): string {
  const t = text.trim();
  if (!word) return t;
  const re = new RegExp(`[\\s,.!?]*\\b${word}\\b[\\s,.!?]*$`, 'i');
  return t.replace(re, '').trim();
}

interface Controls {
  endTurn: () => void;
  end: () => void;
}

/**
 * Call loop with on-device keyword spotting (TF.js):
 *   listen (record + spot the end word) → transcribe once (Whisper) → stream the
 *   reply and speak it (while spotting the stop word for barge-in) → listen again.
 * "Done" button and a max-duration are fallbacks for ending a turn.
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
    let endWord = getEndWord();
    let stopWord = getStopWord();
    let queue: SpeechSession | null = null;
    let maxTimer: number | undefined;
    let finalizing = false;
    let streamAbort: AbortController | null = null;

    // Keyword listener management (one active at a time, token-guarded).
    let kwsStop: (() => void) | null = null;
    let kwsToken = 0;
    const stopKws = () => {
      kwsToken++;
      kwsStop?.();
      kwsStop = null;
    };
    const startKws = (words: string[], onMatch: (w: string) => void) => {
      const token = ++kwsToken;
      kwsStop?.();
      kwsStop = null;
      void listenForWords(words, (w) => {
        if (active && kwsToken === token) onMatch(w);
      })
        .then((stop) => {
          if (!active || kwsToken !== token) {
            stop();
            return;
          }
          kwsStop = stop;
        })
        .catch((e) => log(`kws error: ${e instanceof Error ? e.message : e}`));
    };

    const log = (m: string) => {
      const t = new Date().toLocaleTimeString([], { hour12: false });
      setLogs((prev) => [...prev.slice(-13), `${t} ${m}`]);
    };

    const cleanup = () => {
      active = false;
      if (maxTimer) window.clearTimeout(maxTimer);
      maxTimer = undefined;
      stopKws();
      streamAbort?.abort();
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

    const stopAndGetBlob = (): Promise<Blob | null> =>
      new Promise((resolve) => {
        const rec = recorder;
        if (!rec || rec.state === 'inactive') {
          resolve(null);
          return;
        }
        rec.onstop = () => resolve(new Blob(chunks, { type: baseType }));
        try {
          rec.stop();
        } catch {
          resolve(null);
        }
      });

    const listen = () => {
      if (!active || !stream) return;
      finalizing = false;
      chunks = [];
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
      recorder.start();
      chimeListenStart(); // audible: mic now listening
      maxTimer = window.setTimeout(() => {
        log('max duration → finish');
        void finalize();
      }, MAX_UTTERANCE_MS);
      startKws([endWord], () => {
        log(`end word "${endWord}" → finish`);
        void finalize();
      });
    };

    const finalize = async () => {
      if (!active || finalizing) return;
      finalizing = true;
      chimeListenStop(); // audible: mic stopped listening
      setPhase('processing'); // show a loading state while we transcribe
      if (maxTimer) window.clearTimeout(maxTimer);
      maxTimer = undefined;
      stopKws();
      const blob = await stopAndGetBlob();
      if (!active) return;
      let text = '';
      if (blob && blob.size > 0) {
        try {
          text = await api.transcribe(blob, { filename: `turn.${extFor(baseType)}` });
        } catch (e) {
          log(`transcribe FAIL: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (!active) return;
      const clean = stripTrailingWord(text, endWord);
      log(`heard(${text.trim().length}) → "${clean.slice(0, 40)}"`);
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
      queue = createSpeechSession(() => {
        if (active) {
          stopKws();
          listen();
        }
      });
      // Barge-in: spot the stop word while the assistant is speaking.
      startKws([stopWord], () => {
        log(`stop word "${stopWord}" → interrupt`);
        interrupt();
      });
      streamAbort = new AbortController();
      try {
        await api.sendMessageStream(
          { message: text, commit: true, mode: 'voice' },
          (c) => {
            setResponse((prev) => prev + c);
            queue?.push(c);
          },
          streamAbort.signal,
        );
        queue?.finish();
      } catch (err) {
        if (!active) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        queue?.stop();
        stopKws();
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setPhase('error');
      }
    };

    const interrupt = () => {
      stopKws();
      streamAbort?.abort();
      queue?.stop();
      queue = null;
      if (active) listen();
    };

    controlsRef.current = {
      endTurn: () => {
        log('Done tapped');
        void finalize();
      },
      end: () => {
        cleanup();
        onClose();
      },
    };

    void (async () => {
      try {
        endWord = getEndWord();
        stopWord = getStopWord();
        log(`end="${endWord}" stop="${stopWord}"`);
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone not supported in this browser.');
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        mime = pickMimeType();
        baseType = (mime || 'audio/webm').split(';')[0];
        try {
          await warmUpKeywordSpotter(); // preload model so detection is instant
        } catch (e) {
          log(`keyword model failed: ${e instanceof Error ? e.message : e}`);
        }
        if (!active) return;
        log(`ready, mime=${baseType}`);
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
