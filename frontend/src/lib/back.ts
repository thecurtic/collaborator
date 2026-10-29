import { createContext, useContext, useEffect, useRef } from 'react';
import { isNativeShell } from '@/native/nativeShell';

/**
 * One back stack for the whole app. Anything that can be "gone back from"
 * registers a handler while it is open: a modal, a detail view inside a
 * screen, a pushed screen. Back (the header arrow, the browser or PWA back
 * gesture, the Android shell's back button) runs the topmost one.
 *
 * Topmost = highest layer, then the highest order. Views take their order
 * at first render, so a parent always ranks below the views it renders,
 * whatever order their effects run in. Modals take theirs when they open,
 * so the last one opened closes first.
 *
 * Browser history: while anything is registered, one guard entry sits on
 * top of the page's history, so the back gesture pops the guard (we run
 * the handler and push a new guard if there's still somewhere to go back
 * to) instead of leaving the app. When the stack empties another way, the
 * guard is unwound. The Android shell asks `window.collaboratorBack()`
 * instead, so no guard is kept there.
 */

export const LAYER = { app: 0, view: 1, modal: 2 } as const;

interface Entry {
  layer: number;
  order: number;
  handler: { current: () => void };
}

const entries = new Set<Entry>();
let counter = 0;

/** Whether this subtree is the one on screen (pushed screens stay mounted). */
export const ScreenVisible = createContext(true);

function topmost(): Entry | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!best || e.layer > best.layer || (e.layer === best.layer && e.order > best.order)) {
      best = e;
    }
  }
  return best;
}

/** Go back one step. False when there's nowhere left to go (leave the app). */
export function goBack(): boolean {
  const e = topmost();
  if (!e) return false;
  e.handler.current();
  return true;
}

function register(layer: number, order: number, handler: Entry['handler']): () => void {
  const e: Entry = { layer, order, handler };
  entries.add(e);
  scheduleSync();
  return () => {
    entries.delete(e);
    scheduleSync();
  };
}

/** A fresh order, later than everything before it (modals use it on open). */
export function nextBackOrder(): number {
  return ++counter;
}

/** Register a modal's close (or a no-op that swallows back) while it's open. */
export function registerModalBack(onBack: () => void): () => void {
  return register(LAYER.modal, nextBackOrder(), { current: onBack });
}

/**
 * While `active` (and this screen is the one showing), back runs `onBack`.
 * Use it for a view's inner level: a detail opened from a list, a sub-page.
 */
export function useBack(active: boolean, onBack: () => void, layer: number = LAYER.view) {
  const visible = useContext(ScreenVisible);
  const handler = useRef(onBack);
  handler.current = onBack;
  const order = useRef(0);
  if (!order.current) order.current = nextBackOrder();
  const on = active && visible;
  useEffect(() => (on ? register(layer, order.current, handler) : undefined), [on, layer]);
}

// ---- History guard (browsers and the installed PWA) ----

let installed = false;
let guarded = false;
let unwinding = false;
let syncQueued = false;

function scheduleSync() {
  if (!installed || syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    sync();
  });
}

function sync() {
  if (unwinding) return;
  if (entries.size > 0 && !guarded) {
    window.history.pushState({ collabBack: true }, '');
    guarded = true;
  } else if (entries.size === 0 && guarded) {
    guarded = false;
    unwinding = true;
    window.history.back();
  }
}

function onPopState(e: PopStateEvent) {
  if (unwinding) {
    unwinding = false;
    sync();
    return;
  }
  if ((e.state as { collabBack?: boolean } | null)?.collabBack) {
    // Forward onto an old guard: we're guarded again, nothing to run.
    guarded = true;
    return;
  }
  guarded = false; // the guard was just popped: that was a back
  goBack();
  sync(); // still somewhere to go back to? a fresh guard
}

/** Wire back to the platform. Call once, at startup. */
export function installBack(): () => void {
  (window as { collaboratorBack?: () => boolean }).collaboratorBack = goBack;
  if (isNativeShell()) return () => {};
  installed = true;
  guarded = (window.history.state as { collabBack?: boolean } | null)?.collabBack === true;
  window.addEventListener('popstate', onPopState);
  scheduleSync();
  return () => {
    installed = false;
    window.removeEventListener('popstate', onPopState);
  };
}
