import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '@/api/http';
import { cn } from '@/lib/utils';

/** GET/PUT /api/gate (the backend talks to the gate; the token stays there). */
interface GateState {
  configured: boolean;
  online?: boolean;
  paused?: boolean;
  queued?: number;
  in_flight?: number;
  error?: string;
  warning?: string;
}

const POLL_MS = 5000;
const LABELS = ['Gate offline', 'Collab only', 'All requests'] as const;

/**
 * The inference switch (UX doc, Destinations): on every screen, in the top
 * bar beside the menu. It flips local inference between serving
 * Collaborator only (the gate on the Mac holds the agents' requests) and
 * serving all requests. A pill whose round knob slides to one end with the
 * state written on the other, so it reads at a glance; red while set to
 * Collaborator only. Hidden when no gate is configured; "offline" when the
 * gate can't be reached, which never blocks chat.
 */
export function InferenceSwitch() {
  const [state, setState] = useState<GateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Tapping while offline shows why, under the pill: a title tooltip never
  // shows on a phone.
  const [why, setWhy] = useState<string | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await request<GateState>('/api/gate');
      if (live.current) setState(s);
    } catch {
      /* the next poll tries again */
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onVisible = () =>
      document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live.current = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (state?.online) setWhy(null);
  }, [state?.online]);

  if (!state?.configured) return null;

  const online = state.online === true;
  const collabOnly = online && state.paused === true;

  const flip = async () => {
    if (!online) {
      setWhy('offline');
      void refresh();
      return;
    }
    if (busy) return;
    const next = !collabOnly;
    setBusy(true);
    setFailed(null);
    setState({ ...state, paused: next });
    try {
      setState(
        await request<GateState>('/api/gate', {
          method: 'PUT',
          body: JSON.stringify({ paused: next }),
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'The gate didn’t answer';
      setFailed(msg);
      setWhy(msg);
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const queued = state.queued ?? 0;
  const inFlight = state.in_flight ?? 0;
  const label: (typeof LABELS)[number] = !online
    ? 'Gate offline'
    : collabOnly
      ? 'Collab only'
      : 'All requests';
  const detail = !online
    ? (state.error ??
      'The gate can’t be reached; chat is unaffected. Tap to retry.')
    : [
        collabOnly
          ? 'Serving Collaborator only: the agents’ requests are held. Tap to serve all requests.'
          : 'Serving all requests. Tap to serve Collaborator only.',
        queued ? `${queued} held` : null,
        inFlight ? `${inFlight} in flight` : null,
        state.warning ?? null,
        failed,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        role="switch"
        aria-checked={collabOnly}
        aria-label={`Inference: ${label}`}
        title={detail}
        onClick={() => void flip()}
        className={cn(
          'relative flex h-7 shrink-0 items-center rounded-full border text-[11px] font-semibold transition-colors',
          collabOnly ? 'pl-2 pr-[1.625rem]' : 'pl-[1.625rem] pr-2',
          !online
            ? 'border-border bg-muted text-muted-foreground'
            : collabOnly
              ? 'border-red-600 bg-red-600 text-white'
              : 'border-border bg-secondary text-secondary-foreground',
          busy && 'opacity-70',
        )}
      >
        {/* The state, written on the side the knob isn't. Every label sits in
            the same grid cell, so the pill is as wide as the longest one and
            doesn't change size when it flips. */}
        <span className="inline-grid whitespace-nowrap">
          {LABELS.map((l) => (
            <span
              key={l}
              aria-hidden={l !== label}
              className={cn('col-start-1 row-start-1 text-center', l !== label && 'invisible')}
            >
              {l}
            </span>
          ))}
        </span>
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 flex h-[1.375rem] w-[1.375rem] items-center justify-center rounded-full bg-background text-[10px] font-bold tabular-nums shadow transition-[left] duration-200',
            collabOnly
              ? 'left-[calc(100%-1.5rem)] text-red-600'
              : 'left-0.5 text-muted-foreground',
          )}
        >
          {online && queued > 0 ? queued : ''}
        </span>
      </button>
      {why && (
        <span
          role="status"
          onClick={() => setWhy(null)}
          className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-md border bg-background p-2.5 text-xs leading-snug text-foreground shadow-md"
        >
          {why === 'offline'
            ? (state.error ?? 'The gate can’t be reached.')
            : why}
          {!online && (
            <span className="mt-1 block text-muted-foreground">
              Chat is unaffected. Tap the switch to retry.
            </span>
          )}
        </span>
      )}
    </span>
  );
}
