import { useCallback, useEffect, useRef, useState } from 'react';
import { getSttEngine } from '@/features/settings/uiPrefs';
import { holdPwaUpdates } from '@/pwa';
import { chimeListenStart, chimeListenStop } from './chime';
import { DeviceTranscriber } from './deviceTranscriber';
import { startPcmStream, type PcmStream } from './pcmStreamer';
import { TranscriptionStream } from './transcriptionStream';

export type DictationStatus = 'idle' | 'starting' | 'listening' | 'finishing';

interface Session {
  stream: MediaStream;
  pcm: PcmStream;
  transcriber: DeviceTranscriber | TranscriptionStream;
  releaseHold: () => void;
}

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone blocked. Allow mic access for this site (and note it needs HTTPS or localhost).';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Microphone is in use by another app.';
    default:
      return err instanceof Error ? err.message : 'Could not start dictation.';
  }
}

/**
 * Streaming dictation for the composer: PCM streams to the transcriber WHILE
 * you speak (server WS or on-device worker, per Settings), so partials are
 * live and the final transcript is near-instant on stop — the same pipeline
 * call mode uses, minus keyword spotting. Replaces record-then-upload.
 */
export function useDictation() {
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  // Bumped on every start/cancel so late async results can't cross sessions.
  const tokenRef = useRef(0);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined';

  const teardown = useCallback((finalChime: boolean) => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (!s) return;
    if (finalChime) chimeListenStop();
    s.pcm.stop();
    s.transcriber.close();
    s.stream.getTracks().forEach((t) => t.stop());
    s.releaseHold();
  }, []);

  const start = useCallback(async () => {
    if (!supported || sessionRef.current || status !== 'idle') return;
    const token = ++tokenRef.current;
    setError(null);
    setPartial('');
    // "Starting" until the socket/model is ready and PCM is flowing — don't
    // signal "listening" early or the first words get dropped.
    setStatus('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (tokenRef.current !== token) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const onPartial = (t: string) => {
        if (tokenRef.current === token) setPartial(t);
      };
      const transcriber =
        getSttEngine() === 'device'
          ? new DeviceTranscriber(onPartial)
          : new TranscriptionStream(onPartial);
      try {
        await transcriber.ready();
        if (tokenRef.current !== token) {
          transcriber.close();
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const pcm = await startPcmStream(stream, (buf) =>
          transcriber.sendPcm(buf),
        );
        sessionRef.current = {
          stream,
          pcm,
          transcriber,
          releaseHold: holdPwaUpdates(), // an app update mustn't kill the take
        };
      } catch (err) {
        transcriber.close();
        stream.getTracks().forEach((t) => t.stop());
        throw err;
      }
      setStatus('listening');
      chimeListenStart();
    } catch (err) {
      if (tokenRef.current !== token) return;
      setStatus('idle');
      setError(micError(err));
    }
  }, [supported, status]);

  /** Finish the take; resolves with the final transcript ('' if nothing). */
  const stop = useCallback(async (): Promise<string> => {
    const s = sessionRef.current;
    if (!s || status !== 'listening') return '';
    setStatus('finishing');
    chimeListenStop();
    s.pcm.stop(); // stop feeding audio before asking for the final
    let text = '';
    try {
      text = await s.transcriber.end();
    } catch {
      /* treat as empty — the error state is the empty result */
    }
    teardown(false);
    setStatus('idle');
    setPartial('');
    return text.trim();
  }, [status, teardown]);

  /** Discard the take entirely (unmount / user cancel). */
  const cancel = useCallback(() => {
    tokenRef.current++;
    teardown(true);
    setStatus('idle');
    setPartial('');
  }, [teardown]);

  // Release the mic if the component unmounts mid-take.
  useEffect(() => cancel, [cancel]);

  return { status, partial, error, supported, start, stop, cancel };
}
