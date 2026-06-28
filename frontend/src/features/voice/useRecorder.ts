import { useCallback, useRef, useState } from 'react';

export type RecorderStatus = 'idle' | 'recording';

export interface Recording {
  blob: Blob;
  mimeType: string;
  /** Filename with an extension matching the container (helps the backend). */
  filename: string;
}

/** Pick the best audio container the browser can record. */
function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus', // Chrome/Firefox/Android
    'audio/webm',
    'audio/mp4', // iOS Safari
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? '';
}

function extFor(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/**
 * Microphone capture via MediaRecorder. `start()` requests permission and
 * begins recording; `stop()` resolves with the recorded blob; `cancel()`
 * discards. Tracks are always released so the mic indicator turns off.
 */
export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const supported =
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!supported) {
      setError('Voice recording isn’t supported in this browser.');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start();
      recorderRef.current = rec;
      setStatus('recording');
      return true;
    } catch (err) {
      releaseStream();
      setError(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : 'Could not start recording.',
      );
      return false;
    }
  }, [supported, releaseStream]);

  const stop = useCallback((): Promise<Recording | null> => {
    return new Promise((resolve) => {
      const rec = recorderRef.current;
      if (!rec || rec.state === 'inactive') {
        resolve(null);
        return;
      }
      rec.onstop = () => {
        const mimeType = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        releaseStream();
        recorderRef.current = null;
        setStatus('idle');
        resolve(
          blob.size > 0
            ? { blob, mimeType, filename: `recording.${extFor(mimeType)}` }
            : null,
        );
      };
      rec.stop();
    });
  }, [releaseStream]);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      rec.stop();
    }
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
    setStatus('idle');
  }, [releaseStream]);

  return { status, error, supported, start, stop, cancel };
}
