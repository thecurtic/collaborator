/**
 * Bridge to the Android shell (Capacitor, remote-URL mode). The SAME served
 * bundle runs in browsers and in the shell, so nothing here imports
 * @capacitor/* — we feature-detect the injected `window.Capacitor` global and
 * no-op everywhere else. The shell's one job: a microphone-type foreground
 * service so calls keep capturing with the screen off / app backgrounded.
 * Its notification carries the call's Hang up and Mute buttons.
 */

interface ServiceOptions {
  id: number;
  title: string;
  body: string;
  smallIcon: string;
  silent?: boolean;
  buttons?: { id: number; title: string }[];
}

interface ListenerHandle {
  remove(): Promise<void>;
}

interface ForegroundServicePlugin {
  startForegroundService(options: ServiceOptions): Promise<void>;
  updateForegroundService?(options: ServiceOptions): Promise<void>;
  stopForegroundService(): Promise<void>;
  addListener?(
    event: 'buttonClicked',
    fn: (e: { buttonId: number }) => void,
  ): Promise<ListenerHandle>;
  checkPermissions?(): Promise<{ display?: string }>;
  requestPermissions?(): Promise<{ display?: string }>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { ForegroundService?: ForegroundServicePlugin };
}

function capacitor(): CapacitorGlobal | undefined {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True when running inside the Android shell (vs. a plain browser/PWA). */
export function isNativeShell(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

const HANG_UP = 1;
const MUTE = 2;

/** What the call's notification buttons do. */
export interface CallServiceActions {
  hangUp: () => void;
  toggleMute: () => void;
}

let buttonListener: ListenerHandle | null = null;

function callNotice(muted: boolean): ServiceOptions {
  return {
    id: 1,
    title: 'Collaborator',
    body: muted ? 'Call in progress — muted' : 'Call in progress — microphone active',
    smallIcon: 'ic_stat_call',
    silent: true,
    buttons: [
      { id: HANG_UP, title: 'Hang up' },
      { id: MUTE, title: muted ? 'Unmute' : 'Mute' },
    ],
  };
}

/**
 * Start the mic foreground service (persistent "call in progress"
 * notification with Hang up and Mute). Requests notification permission on
 * first use (13+). Safe to call anywhere — silently no-ops outside the shell.
 */
export async function startCallService(actions?: CallServiceActions): Promise<void> {
  const fg = capacitor()?.Plugins?.ForegroundService;
  if (!fg || !isNativeShell()) return;
  try {
    const perm = await fg.checkPermissions?.();
    if (perm?.display && perm.display !== 'granted') {
      await fg.requestPermissions?.();
    }
    await buttonListener?.remove();
    buttonListener = null;
    if (actions && fg.addListener) {
      buttonListener = await fg.addListener('buttonClicked', (e) => {
        if (e.buttonId === HANG_UP) actions.hangUp();
        else if (e.buttonId === MUTE) actions.toggleMute();
      });
    }
    await fg.startForegroundService(callNotice(false));
  } catch {
    // Shell without the plugin / permission denied: the call still works,
    // it just won't survive the screen turning off.
  }
}

/** Reflect the mute state on the call notification. No-op outside the shell. */
export async function updateCallService(muted: boolean): Promise<void> {
  const fg = capacitor()?.Plugins?.ForegroundService;
  if (!fg?.updateForegroundService || !isNativeShell()) return;
  try {
    await fg.updateForegroundService(callNotice(muted));
  } catch {
    /* service not running */
  }
}

/** Stop the mic foreground service (call ended). No-op outside the shell. */
export async function stopCallService(): Promise<void> {
  try {
    await buttonListener?.remove();
    buttonListener = null;
    await capacitor()?.Plugins?.ForegroundService?.stopForegroundService();
  } catch {
    /* already stopped / not running */
  }
}
