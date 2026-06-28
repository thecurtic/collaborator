import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { SpeechQueue } from './speechQueue';

export type CallPhase = 'connecting' | 'listening' | 'responding' | 'error';

// Each listening "segment" is recorded to completion, then transcribed — partial
// (still-recording) WebM blobs don't decode reliably, so we never transcribe one.
const SEGMENT_MS = 3500;
const MAX_UTTERANCE_MS = 30000; // safety: force-finish a very long turn
const MAX_TRANSCRIBE_FAILS = 3; // surface an error instead of looping silently
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
 * Drives the call loop:
 *   listen (record fixed segments → transcribe each → accumulate) until the
 *   configurable end phrase appears, the user taps "Done", or a max duration —
 *   then stream the reply (live tokens) and speak it via Piper sentence by
 *   sentence, then listen again.
 */
export function useCall(open: boolean, onClose: () => void) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
  const [partial, setPartial] = useState(''); // user's accumulated transcript
  const [response, setResponse] = useState(''); // assistant streaming text
  const [error, setError] = useState<string | null>(null);
  const controlsRef = useRef<Controls | null>(null);

  useEffect(() => {
    if (!open) return;

    let active = true;
    let stream: MediaStream | null = null;
    let segRecorder: MediaRecorder | null = null;
    let segChunks: Blob[] = [];
    let segTimer: number | undefined;
    let stopRequested = false;
    let mime = '';
    let baseType = 'audio/webm';
    let endPhrase = DEFAULT_END_PHRASE;
    let queue: SpeechQueue | null = null;
    let fails = 0;

    const stopSeg = () => {
      if (segTimer) {
        window.clearTimeout(segTimer);
        segTimer = undefined;
      }
      if (segRecorder && segRecorder.state === 'recording') {
        try {
          segRecorder.stop();
        } catch {
          /* ignore */
        }
      }
    };

    const cleanup = () => {
      active = false;
      if (segTimer) window.clearTimeout(segTimer);
      segTimer = undefined;
      if (segRecorder && segRecorder.state !== 'inactive') {
        segRecorder.onstop = null;
        try {
          segRecorder.stop();
        } catch {
          /* ignore */
        }
      }
      segRecorder = null;
      queue?.stop();
      queue = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    // Record one segment; resolves with a complete blob when it stops (either the
    // segment timer fires or the user taps "Done", which calls stopSeg()).
    const recordSegment = (): Promise<Blob | null> =>
      new Promise((resolve) => {
        if (!active || !stream) {
          resolve(null);
          return;
        }
        segChunks = [];
        let rec: MediaRecorder;
        try {
          rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        } catch {
          resolve(null);
          return;
        }
        segRecorder = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) segChunks.push(e.data);
        };
        rec.onstop = () => {
          if (segTimer) {
            window.clearTimeout(segTimer);
            segTimer = undefined;
          }
          const blob = new Blob(segChunks, { type: baseType });
          resolve(blob.size > 0 ? blob : null);
        };
        try {
          rec.start();
        } catch {
          resolve(null);
          return;
        }
        segTimer = window.setTimeout(() => {
          if (rec.state === 'recording') {
            try {
              rec.stop();
            } catch {
              /* ignore */
            }
          }
        }, SEGMENT_MS);
      });

    const listen = async () => {
      if (!active) return;
      setPhase('listening');
      setPartial('');
      setResponse('');
      let accumulated = '';
      stopRequested = false;
      const turnStart = Date.now();

      while (active) {
        const blob = await recordSegment();
        if (!active) return;

        if (blob) {
          try {
            const segText = await api.transcribe(blob, {
              filename: `seg.${extFor(baseType)}`,
            });
            fails = 0;
            if (!active) return;
            if (segText.trim()) {
              accumulated = `${accumulated} ${segText.trim()}`.trim();
              setPartial(accumulated);
            }
          } catch {
            fails += 1;
            if (fails >= MAX_TRANSCRIBE_FAILS) {
              setError(
                'Transcription keeps failing — check the backend, then end and retry the call.',
              );
              setPhase('error');
              return;
            }
          }
        }

        const timedOut = Date.now() - turnStart > MAX_UTTERANCE_MS;
        const phraseHit = containsPhrase(accumulated, endPhrase);
        if (stopRequested || phraseHit || timedOut) {
          const finalText = stripPhrase(accumulated, endPhrase);
          if (finalText) {
            await respond(finalText);
            return;
          }
          // Nothing intelligible yet — keep listening.
          stopRequested = false;
        }
      }
    };

    const respond = async (text: string) => {
      if (!active) return;
      setPhase('responding');
      setPartial(text);
      setResponse('');
      queue = new SpeechQueue(() => {
        if (active) void listen();
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
        stopRequested = true;
        stopSeg(); // end the current segment now so we respond promptly
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
        baseType = (mime || 'audio/webm').split(';')[0];
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

  return { phase, partial, response, error, endTurn, end };
}
