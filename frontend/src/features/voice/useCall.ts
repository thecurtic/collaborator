import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { SpeechQueue } from './speechQueue';

export type CallPhase = 'connecting' | 'listening' | 'responding' | 'error';

// Turn ends after this much silence once the user has started speaking.
const SILENCE_MS = 1500;
// RMS energy (0..1) above this counts as speech. Tunable.
const VOICE_THRESHOLD = 0.025;
const MAX_UTTERANCE_MS = 30000; // safety cap on a single turn
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

/** Remove a trailing end-phrase (e.g. "…what's the weather go ahead"). */
function stripPhrase(text: string, phrase: string): string {
  const t = text.trim();
  if (!phrase) return t;
  const lower = t.toLowerCase();
  const p = phrase.toLowerCase();
  if (lower.endsWith(p)) return t.slice(0, t.length - p.length).trim();
  // also handle trailing punctuation after the phrase
  const idx = lower.lastIndexOf(p);
  if (idx !== -1 && lower.slice(idx + p.length).replace(/[\s.!?,]/g, '') === '') {
    return t.slice(0, idx).trim();
  }
  return t;
}

interface Controls {
  endTurn: () => void;
  end: () => void;
}

/**
 * Call loop: record a full utterance, ended by silence detection (VAD), the
 * "Done" button, or a max duration → transcribe once → stream the reply (live
 * tokens) and speak it via Piper sentence by sentence → listen again.
 */
export function useCall(open: boolean, onClose: () => void) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
  const [partial, setPartial] = useState(''); // last transcript sent
  const [response, setResponse] = useState(''); // assistant streaming text
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
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let vadTimer: number | undefined;
    let maxTimer: number | undefined;
    let finishing = false;
    let hasSpoken = false;
    let lastVoice = 0;

    const log = (m: string) => {
      const t = new Date().toLocaleTimeString([], { hour12: false });
      setLogs((prev) => [...prev.slice(-13), `${t} ${m}`]);
    };

    const clearTurnTimers = () => {
      if (vadTimer) window.clearInterval(vadTimer);
      if (maxTimer) window.clearTimeout(maxTimer);
      vadTimer = maxTimer = undefined;
    };

    const cleanup = () => {
      active = false;
      clearTurnTimers();
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
      void audioCtx?.close().catch(() => {});
      audioCtx = null;
      analyser = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const startVad = () => {
      if (!analyser) return;
      const data = new Uint8Array(analyser.fftSize);
      hasSpoken = false;
      lastVoice = Date.now();
      vadTimer = window.setInterval(() => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const d = (v - 128) / 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        if (rms > VOICE_THRESHOLD) {
          if (!hasSpoken) log('speech detected');
          hasSpoken = true;
          lastVoice = now;
        } else if (hasSpoken && now - lastVoice > SILENCE_MS) {
          log('silence → finish');
          finishTurn();
        }
      }, 100);
    };

    const listen = () => {
      if (!active || !stream) return;
      finishing = false;
      chunks = [];
      setPhase('listening');
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
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: baseType });
        void handleUtterance(blob);
      };
      recorder.start();
      startVad();
      maxTimer = window.setTimeout(() => {
        log('max duration → finish');
        finishTurn();
      }, MAX_UTTERANCE_MS);
    };

    // Stop the recorder; its onstop builds the blob and calls handleUtterance.
    const finishTurn = () => {
      if (finishing) return;
      finishing = true;
      clearTurnTimers();
      if (recorder && recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          void handleUtterance(null);
        }
      } else {
        void handleUtterance(null);
      }
    };

    const handleUtterance = async (blob: Blob | null) => {
      if (!active) return;
      log(`utterance ${blob ? `${Math.round(blob.size / 1024)}KB` : 'EMPTY'}`);
      let text = '';
      if (blob && blob.size > 0) {
        try {
          text = await api.transcribe(blob, { filename: `turn.${extFor(baseType)}` });
        } catch (e) {
          log(`transcribe FAIL: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (!active) return;
      const clean = stripPhrase(text, endPhrase);
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
        finishTurn();
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
        // Audio analysis for silence detection.
        try {
          const Ctx =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext;
          audioCtx = new Ctx();
          void audioCtx.resume();
          const src = audioCtx.createMediaStreamSource(stream);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
        } catch {
          analyser = null; // VAD unavailable; Done button still works
        }
        log(`mic ok, mime=${baseType}, vad=${analyser ? 'on' : 'off'}`);
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
