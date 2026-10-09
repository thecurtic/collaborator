import { getLocationEnabled } from '@/features/settings/uiPrefs';
import type { TurnLocation } from '@/domain/models';

/**
 * Best-effort current location for a turn (b23d8ea). Resolves undefined —
 * never rejects — when the toggle is off, permission is missing, or a fix
 * doesn't arrive quickly: a send must not stall on GPS. maximumAge leans on
 * the OS cache so only the first fix after enabling costs anything.
 */
export function currentLocation(): Promise<TurnLocation | undefined> {
  if (!getLocationEnabled() || !navigator.geolocation) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          ts: Math.round(pos.timestamp / 1000),
        }),
      () => resolve(undefined),
      { maximumAge: 120_000, timeout: 2_500 },
    );
  });
}
