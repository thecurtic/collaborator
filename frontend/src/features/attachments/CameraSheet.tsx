import { AlertCircle, Camera, Loader2, RotateCw, SwitchCamera, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';
import { cn } from '@/lib/utils';

/** A photo in the tray: uploading, uploaded, or failed (with a retry). */
export interface CameraShot {
  key: string;
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'error';
  progress: number;
}

/** Taken, still being encoded: its thumbnail shows already. */
interface Encoding {
  key: number;
  thumb: string;
}

let shotSeq = 0;
const THUMB_PX = 160;

function photoName(n: number): string {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  return (
    `photo-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${n}.jpg`
  );
}

/**
 * The in-app camera: snap, snap, snap, Done. Each photo drops into the tray
 * the instant it's taken (a small thumbnail drawn from the frame, before
 * the full-size picture is encoded) and is handed over at once (`onShot`),
 * so its upload starts while the next is taken; the tray shows each one's
 * progress (`shots`, from the owner), a failed one with a retry. Done is
 * there from the first photo and just closes: uploads carry on.
 *
 * Back keeps what was taken (the same as Done); only the × at the top
 * discards this session's photos, and asks for a second tap first.
 *
 * When the camera can't be opened here (no permission, no camera), it
 * offers the phone's own camera app instead, one photo at a time.
 */
export function CameraSheet({
  open,
  onClose,
  onShot,
  shots: allShots,
  onRemove,
  onRetry,
}: {
  open: boolean;
  onClose: () => void;
  /** A photo taken: start its upload; returns the key its tray entry has. */
  onShot: (file: File) => string | undefined;
  /** The owner's pending files (only this session's show in the tray). */
  shots: CameraShot[];
  onRemove: (key: string) => void;
  /** Absent: a failed photo shows as failed, with no retry. */
  onRetry?: (key: string) => void;
}) {
  const [sessionKeys, setSessionKeys] = useState<string[]>([]);
  const [encoding, setEncoding] = useState<Encoding[]>([]);
  const shots = allShots.filter((s) => sessionKeys.includes(s.key));
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [canFlip, setCanFlip] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fallbackRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef(sessionKeys);
  sessionRef.current = sessionKeys;
  const taken = shots.length + encoding.length;

  const hand = (file: File) => {
    const key = onShot(file);
    if (key) setSessionKeys((prev) => [...prev, key]);
  };

  const finish = () => {
    setSessionKeys([]);
    setConfirmDiscard(false);
    onClose();
  };

  const discard = () => {
    if (taken > 0 && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    sessionRef.current.forEach(onRemove);
    setSessionKeys([]);
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
    // The tray shows the shot now: a small thumbnail is quick to draw, the
    // full-size JPEG takes a moment longer.
    const n = ++shotSeq;
    const scale = THUMB_PX / Math.max(canvas.width, canvas.height);
    const thumb = document.createElement('canvas');
    thumb.width = Math.round(canvas.width * scale);
    thumb.height = Math.round(canvas.height * scale);
    thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    setEncoding((prev) => [...prev, { key: n, thumb: thumb.toDataURL('image/jpeg', 0.7) }]);
    setConfirmDiscard(false);
    canvas.toBlob(
      (blob) => {
        setEncoding((prev) => prev.filter((e) => e.key !== n));
        if (blob) hand(new File([blob], photoName(n), { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.92,
    );
  };

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
                Discard {taken} photo{taken === 1 ? '' : 's'}?
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
            if (f) hand(f);
          }}
        />
      </div>

      <div className="pb-safe">
        <div className="px-3 pb-4 pt-3">
          {taken > 0 && (
            <div className="mb-3 flex gap-2 overflow-x-auto">
              {shots.map((s) => (
                <div key={s.key} className="relative shrink-0">
                  {s.previewUrl ? (
                    <img src={s.previewUrl} alt="" className="h-16 w-16 rounded-lg object-cover" />
                  ) : (
                    <div className="h-16 w-16 rounded-lg bg-white/10" />
                  )}
                  {s.status === 'uploading' && (
                    <div className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full bg-black/50">
                      <div className="h-full bg-white transition-[width]"
                           style={{ width: `${Math.round(s.progress * 100)}%` }} />
                    </div>
                  )}
                  {s.status === 'error' && !onRetry && (
                    <span className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-black/60 text-[10px]">
                      <AlertCircle className="h-4 w-4 text-destructive" /> Failed
                    </span>
                  )}
                  {s.status === 'error' && onRetry && (
                    <button
                      type="button"
                      onClick={() => onRetry(s.key)}
                      aria-label="Upload failed: retry"
                      className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 rounded-lg bg-black/60 text-[10px] active:scale-95"
                    >
                      <AlertCircle className="h-4 w-4 text-destructive" />
                      <span className="flex items-center gap-0.5"><RotateCw className="h-3 w-3" /> Retry</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onRemove(s.key);
                      setSessionKeys((prev) => prev.filter((k) => k !== s.key));
                    }}
                    aria-label="Remove this photo"
                    className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 active:scale-90"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {encoding.map((e) => (
                <div key={`e${e.key}`} className="relative shrink-0">
                  <img src={e.thumb} alt="" className="h-16 w-16 rounded-lg object-cover opacity-80" />
                  <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin" />
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
              {taken > 0 && (
                <Button onClick={finish} className="rounded-full px-5">
                  Done · {taken}
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
