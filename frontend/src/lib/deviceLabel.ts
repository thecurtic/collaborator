import { isNativeShell } from '@/native/nativeShell';

/**
 * Human-readable label for this device's session — what the devices list
 * shows ("Android app", "Windows · Chrome (PWA)"). Best-effort UA sniffing;
 * precision doesn't matter, recognizability does.
 */
export function deviceLabel(): string {
  if (isNativeShell()) return 'Android app';
  const ua = navigator.userAgent;
  const platform = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Device';
  // Order matters: Edge UAs contain "Chrome", Chrome UAs contain "Safari".
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const pwa = window.matchMedia?.('(display-mode: standalone)').matches
    ? ' (PWA)'
    : '';
  return `${platform} · ${browser}${pwa}`;
}
