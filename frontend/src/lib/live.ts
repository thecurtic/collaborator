import { useContext, useEffect, useRef } from 'react';
import { api } from '@/api/collaborator';
import { BASE_URL, CLIENT_ID } from '@/api/http';
import { ScreenVisible } from '@/lib/back';

/**
 * Live updates from the user's other devices (GET /api/live, server-sent
 * events). The server says which area changed; screens showing that area
 * reload it through the normal API. One connection per running app, opened
 * while anything listens.
 *
 * A phone drops the connection when it sleeps, so whenever it comes back
 * after a gap, every listener reloads once: whatever changed meanwhile is
 * picked up the same way.
 */

export type LiveArea =
  | 'chats'
  | 'notes'
  | 'drafts'
  | 'scratch'
  | 'transcripts'
  | 'projects'
  | 'feed'
  | 'wallet'
  | 'spending'
  /** A reply streaming on another device (carries the text so far). */
  | 'reply';

/** What a 'reply' message carries (backend live.publish_reply). */
export interface LiveReply {
  id: string;
  /** The turn it answers from (null for a brand-new chat). */
  parent: number | null;
  paragraph: number | null;
  user: string;
  text: string;
  done: boolean;
}

/** A message from the server; undefined when resyncing after a gap. */
export interface LiveMessage {
  areas: string[];
  origin?: string;
  reply?: LiveReply;
}

interface Listener {
  areas: LiveArea[] | '*';
  fn: (msg?: LiveMessage) => void;
}

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connecting = false;
let everConnected = false;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | null = null;

function notify(areas: string[] | '*', msg?: LiveMessage) {
  for (const l of listeners) {
    if (areas === '*' || l.areas === '*' || l.areas.some((a) => areas.includes(a))) l.fn(msg);
  }
}

async function connect() {
  if (source || connecting || listeners.size === 0) return;
  connecting = true;
  let ticket: string;
  try {
    ticket = await api.getWsTicket();
  } catch {
    connecting = false;
    schedule();
    return;
  }
  connecting = false;
  if (listeners.size === 0) return;
  const es = new EventSource(`${BASE_URL}/api/live?ticket=${encodeURIComponent(ticket)}`);
  source = es;
  es.addEventListener('hello', () => {
    // Back after a gap: changes may have been missed, so everyone reloads.
    if (everConnected) notify('*');
    everConnected = true;
    attempt = 0;
  });
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as LiveMessage;
      if (msg.origin === CLIENT_ID || !msg.areas) return; // our own change
      notify(msg.areas, msg);
    } catch {
      /* a malformed message changes nothing */
    }
  };
  es.onerror = () => {
    // The ticket is single-use, so EventSource can't reconnect by itself.
    es.close();
    if (source === es) source = null;
    schedule();
  };
}

function schedule() {
  if (retry || listeners.size === 0) return;
  attempt += 1;
  retry = setTimeout(() => {
    retry = null;
    void connect();
  }, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
}

function disconnect() {
  source?.close();
  source = null;
  if (retry) clearTimeout(retry);
  retry = null;
}

if (typeof document !== 'undefined') {
  // Back in the foreground: reconnect now, not on the backoff timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || listeners.size === 0) return;
    if (!source || source.readyState === EventSource.CLOSED) {
      source = null;
      if (retry) clearTimeout(retry);
      retry = null;
      attempt = 0;
      void connect();
    }
  });
}

/**
 * Listen for changes to `areas` ('*' = any). `fn` gets the message, or
 * nothing when it's a resync after a gap. Returns the unsubscribe.
 */
export function subscribeLive(
  areas: LiveArea[] | '*',
  fn: (msg?: LiveMessage) => void,
): () => void {
  const l: Listener = { areas, fn };
  listeners.add(l);
  void connect();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) disconnect();
  };
}

/**
 * Reload when another device changes `areas`. Bursts are coalesced; a screen
 * that's hidden (pushed under another) reloads when it shows again instead.
 * Pass `enabled: false` to hold off (e.g. while a reply is streaming): the
 * reload then happens once it's re-enabled.
 */
export function useLive(areas: LiveArea[] | '*', onChange: () => void, enabled = true) {
  const visible = useContext(ScreenVisible);
  const fn = useRef(onChange);
  fn.current = onChange;
  const ready = useRef(visible && enabled);
  ready.current = visible && enabled;
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = areas === '*' ? '*' : [...areas].sort().join(',');

  useEffect(() => {
    const unsubscribe = subscribeLive(areas, () => {
      if (!ready.current) {
        dirty.current = true;
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (ready.current) fn.current();
        else dirty.current = true;
      }, 250);
    });
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (visible && enabled && dirty.current) {
      dirty.current = false;
      fn.current();
    }
  }, [visible, enabled]);
}
