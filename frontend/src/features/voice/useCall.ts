import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { getEndWord, getStopWord } from '@/features/settings/uiPrefs';
import { chimeListenStart, chimeListenStop } from './chime';
import { listenForWords, warmUpKeywordSpotter } from './keywordSpotter';
import { startPcmStream, type PcmStream } from './pcmStreamer';
import { createSpeechSession, type SpeechSession } from './speech';
import { TranscriptionStream } from './transcriptionStream';

export type CallPhase =
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'responding'
  | 'error';

const MAX_UTTERANCE_MS = 60000; // safety cap on a single turn
// Detection confidence. "stop" listens while the agent (and room noise) is
// audible, so it must be strict to avoid false interrupts that cut speech short.
const END_WORD_THRESHOLD = 0.85;
const STOP_WORD_THRESHOLD = 0.97;

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
 * Call loop with on-device keyword spotting (TF.js) and streaming transcription:
 *   listen (stream PCM16 to WS, show live partials, spot the end word) → on
 *   end-of-turn take the final transcript → stream the reply and speak it (while
 *   spotting the stop word for barge-in) → listen again.
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
    let pcm: PcmStream | null = null;
    let transcriber: TranscriptionStream | null = null;
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
    const startKws = (
      words: string[],
      onMatch: (w: string) => void,
      threshold: number,
    ) => {
      const token = ++kwsToken;
      kwsStop?.();
      kwsStop = null;
      void listenForWords(
        words,
        (w) => {
          if (active && kwsToken === token) onMatch(w);
        },
        threshold,
      )
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

    const stopCapture = () => {
      pcm?.stop();
      pcm = null;
    };

    const cleanup = () => {
      active = false;
      if (maxTimer) window.clearTimeout(maxTimer);
      maxTimer = undefined;
      stopKws();
      streamAbort?.abort();
      stopCapture();
      transcriber?.close();
      transcriber = null;
      queue?.stop();
      queue = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const listen = async () => {
      if (!active || !stream) return;
      finalizing = false;
      setPartial('');
      setResponse('');
      // Show a brief connecting state — don't signal "listening" until the socket
      // is open and PCM is actually flowing, or we'd drop the start of speech.
      setPhase('connecting');
      try {
        transcriber = new TranscriptionStream((t) => {
          if (active && !finalizing) setPartial(t);
        });
        await transcriber.ready();
        if (!active) {
          transcriber.close();
          transcriber = null;
          return;
        }
        pcm = await startPcmStream(stream, (buf) => transcriber?.sendPcm(buf));
      } catch (e) {
        if (!active) return;
        log(`stream start FAIL: ${e instanceof Error ? e.message : e}`);
        setPhase('error');
        setError('Could not open the transcription stream.');
        return;
      }
      if (!active) {
        stopCapture();
        return;
      }
      setPhase('listening');
      chimeListenStart(); // audible: mic now listening
      maxTimer = window.setTimeout(() => {
        log('max duration → finish');
        void finalize();
      }, MAX_UTTERANCE_MS);
      startKws(
        [endWord],
        () => {
          log(`end word "${endWord}" → finish`);
          void finalize();
        },
        END_WORD_THRESHOLD,
      );
    };

    const finalize = async () => {
      if (!active || finalizing) return;
      finalizing = true;
      chimeListenStop(); // audible: mic stopped listening
      setPhase('processing'); // brief — final is usually ready immediately
      if (maxTimer) window.clearTimeout(maxTimer);
      maxTimer = undefined;
      stopKws();
      stopCapture(); // stop sending audio before asking for the final
      let text = '';
      try {
        text = (await transcriber?.end()) ?? '';
      } catch (e) {
        log(`transcribe FAIL: ${e instanceof Error ? e.message : e}`);
      }
      transcriber?.close();
      transcriber = null;
      if (!active) return;
      const clean = stripTrailingWord(text, endWord);
      log(`heard(${text.trim().length}) → "${clean.slice(0, 40)}"`);
      if (clean) {
        await respond(clean);
      } else {
        void listen(); // nothing intelligible — listen again
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
          void listen();
        }
      });
      // Barge-in: spot the stop word while the assistant is speaking. Strict
      // threshold so the agent's own audio / room noise doesn't false-trigger.
      startKws(
        [stopWord],
        () => {
          log(`stop word "${stopWord}" → interrupt`);
          interrupt();
        },
        STOP_WORD_THRESHOLD,
      );
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
      if (active) void listen();
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
        try {
          await warmUpKeywordSpotter(); // preload model so detection is instant
        } catch (e) {
          log(`keyword model failed: ${e instanceof Error ? e.message : e}`);
        }
        if (!active) return;
        log('ready (streaming PCM16 16k)');
        void listen();
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
