import { Camera, Loader2, SwitchCamera, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';
import { cn } from '@/lib/utils';

interface Shot {
  key: number;
  file: File;
  url: string;
}

let shotSeq = 0;

function photoName(n: number): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  return (
    `photo-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${n}.jpg`
  );
}

/**
 * The in-app camera: take one photo or several, then hand them all over.
 * Shots collect in a strip at the bottom (tap one's × to drop it). Back
 * keeps what was taken (it's the same as Done); only the × at the top
 * discards, and with photos taken it asks for a second tap first.
 *
 * When the camera can't be opened here (no permission, no camera), it
 * offers the phone's own camera app instead, one photo at a time.
 */
export function CameraSheet({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (files: File[]) => void;
}) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [canFlip, setCanFlip] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fallbackRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const finish = () => {
    const files = shotsRef.current.map((s) => s.file);
    shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url));
    setShots([]);
    setConfirmDiscard(false);
    if (files.length) onDone(files);
    onClose();
  };

  const discard = () => {
    if (shotsRef.current.length > 0 && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url));
    setShots([]);
    setConfirmDiscard(false);
    onClose();
  };

  // Back keeps the photos: losing a burst of shots to a stray gesture would
  // be worse than handing over one too many.
  const panelRef = useModalA11y<HTMLDivElement>(open, finish);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('starting');
    setError(null);
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setError('This browser can’t open the camera here.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 4096 },
            height: { ideal: 3072 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
          // The shutter waits for the first frame: before it there is
          // nothing to take, and a tap would silently do nothing.
          if (!video.videoWidth) {
            await new Promise<void>((resolve) =>
              video.addEventListener('loadeddata', () => resolve(), { once: true }),
            );
          }
          if (cancelled) return;
        }
        setStatus('ready');
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!cancelled) setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        const name = err instanceof DOMException ? err.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission is off for Collaborator.'
            : name === 'NotFoundError'
              ? 'No camera found.'
              : 'The camera couldn’t be opened.',
        );
      }
    };
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open, facing]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || status !== 'ready' || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (facing === 'user') {
      // What the preview showed (mirrored), not the sensor's raw view.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const n = ++shotSeq;
        const file = new File([blob], photoName(n), { type: 'image/jpeg' });
        setShots((prev) => [...prev, { key: n, file, url: URL.createObjectURL(blob) }]);
        setConfirmDiscard(false);
      },
      'image/jpeg',
      0.92,
    );
  };

  const drop = (key: number) =>
    setShots((prev) => {
      const s = prev.find((x) => x.key === key);
      if (s) URL.revokeObjectURL(s.url);
      return prev.filter((x) => x.key !== key);
    });

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Camera"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none"
    >
      <div className="pt-safe">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={discard}
            aria-label={confirmDiscard ? 'Tap again to discard the photos' : 'Close the camera'}
            className={cn(
              'flex h-10 items-center gap-1.5 rounded-full px-2.5 active:scale-95',
              confirmDiscard ? 'bg-destructive text-destructive-foreground' : 'bg-white/10',
            )}
          >
            <X className="h-5 w-5" />
            {confirmDiscard && (
              <span className="text-sm">
                Discard {shots.length} photo{shots.length === 1 ? '' : 's'}?
              </span>
            )}
          </button>
          <span className="ml-auto" />
          {canFlip && status === 'ready' && (
            <button
              type="button"
              onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
              aria-label="Switch camera"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 active:scale-95"
            >
              <SwitchCamera className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          playsInline
          muted
          className={cn(
            'h-full w-full object-contain',
            facing === 'user' && '-scale-x-100',
            status !== 'ready' && 'invisible',
          )}
        />
        {status === 'starting' && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/70">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening the camera…
          </p>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="text-sm text-white/80">{error}</p>
            <Button variant="secondary" onClick={() => fallbackRef.current?.click()}>
              <Camera className="mr-1.5 h-4 w-4" />
              Use the phone’s camera app
            </Button>
          </div>
        )}
        {flash && <div className="pointer-events-none absolute inset-0 bg-white/70" />}
        <input
          ref={fallbackRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const n = ++shotSeq;
            setShots((prev) => [...prev, { key: n, file: f, url: URL.createObjectURL(f) }]);
          }}
        />
      </div>

      <div className="pb-safe">
        <div className="px-3 pb-4 pt-3">
          {shots.length > 0 && (
            <div className="mb-3 flex gap-2 overflow-x-auto">
              {shots.map((s) => (
                <div key={s.key} className="relative shrink-0">
                  <img src={s.url} alt="" className="h-16 w-16 rounded-lg object-cover" />
                  <button
                    type="button"
                    onClick={() => drop(s.key)}
                    aria-label="Remove this photo"
                    className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 active:scale-90"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center">
            <span className="flex-1" />
            <button
              type="button"
              onClick={capture}
              disabled={status !== 'ready'}
              aria-label="Take a photo"
              className="h-[72px] w-[72px] rounded-full border-4 border-white bg-white/20 transition active:scale-90 active:bg-white/60 disabled:opacity-40"
            />
            <span className="flex flex-1 justify-end">
              {shots.length > 0 && (
                <Button onClick={finish} className="rounded-full px-5">
                  Done · {shots.length}
                </Button>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
