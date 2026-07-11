/**
 * Bridge to the Android shell (Capacitor, remote-URL mode). The SAME served
 * bundle runs in browsers and in the shell, so nothing here imports
 * @capacitor/* — we feature-detect the injected `window.Capacitor` global and
 * no-op everywhere else. The shell's one job: a microphone-type foreground
 * service so calls keep capturing with the screen off / app backgrounded.
 */

interface ForegroundServicePlugin {
  startForegroundService(options: {
    id: number;
    title: string;
    body: string;
    smallIcon: string;
    silent?: boolean;
  }): Promise<void>;
  stopForegroundService(): Promise<void>;
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

/**
 * Start the mic foreground service (persistent "call in progress"
 * notification). Requests notification permission on first use (13+).
 * Safe to call anywhere — silently no-ops outside the shell.
 */
export async function startCallService(): Promise<void> {
  const fg = capacitor()?.Plugins?.ForegroundService;
  if (!fg || !isNativeShell()) return;
  try {
    const perm = await fg.checkPermissions?.();
    if (perm?.display && perm.display !== 'granted') {
      await fg.requestPermissions?.();
    }
    await fg.startForegroundService({
      id: 1,
      title: 'Collaborator',
      body: 'Call in progress — microphone active',
      smallIcon: 'ic_stat_call',
      silent: true,
    });
  } catch {
    // Shell without the plugin / permission denied: the call still works,
    // it just won't survive the screen turning off.
  }
}

/** Stop the mic foreground service (call ended). No-op outside the shell. */
export async function stopCallService(): Promise<void> {
  try {
    await capacitor()?.Plugins?.ForegroundService?.stopForegroundService();
  } catch {
    /* already stopped / not running */
  }
}
