import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { Button } from '@/components/ui/button';
import type { NotificationSettings } from '@/domain/models';
import { cn } from '@/lib/utils';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/**
 * Settings → Notifications (UX doc): the list of notification kinds, every
 * one optional, so new kinds slot in later. Server-backed and per user.
 * Delivery to the phone is the user's own ntfy server, configured on the
 * server; until then notifications are only recorded, and this says so.
 */
export function NotificationsSection({ open }: { open: boolean }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setTestResult(null);
    api
      .getNotificationSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggle = (kind: string, next: boolean) => {
    if (!settings) return;
    const prev = settings;
    setSettings({
      ...settings,
      kinds: settings.kinds.map((k) =>
        k.kind === kind ? { ...k, enabled: next } : k,
      ),
    }); // optimistic
    api
      .setNotificationKinds({ [kind]: next })
      .then(setSettings)
      .catch((err) => {
        setSettings(prev);
        setError(errMessage(err));
      });
  };

  const sendTest = () => {
    setTesting(true);
    setTestResult(null);
    api
      .sendTestNotification()
      .then((status) =>
        setTestResult(status === 'ntfy' ? 'Sent — check your phone.' : status),
      )
      .catch((err) => setTestResult(errMessage(err)))
      .finally(() => setTesting(false));
  };

  return (
    <div className="mt-5 space-y-3 border-t border-border pt-4">
      <p className="text-sm font-medium">Notifications</p>
      {!settings && !error && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      )}
      {settings?.kinds.map((k) => (
        <div key={k.kind} className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm">{k.label}</p>
            <p className="text-xs text-muted-foreground">{k.description}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={k.enabled}
            aria-label={k.label}
            onClick={() => toggle(k.kind, !k.enabled)}
            className={cn(
              'relative h-6 w-11 shrink-0 rounded-full transition-colors',
              k.enabled ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'block h-5 w-5 rounded-full bg-white transition-transform',
                k.enabled ? 'translate-x-5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      ))}
      {settings &&
        (settings.ntfyConfigured ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={sendTest}
              disabled={testing}
            >
              {testing && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Send a test
            </Button>
            {testResult && (
              <span className="text-xs text-muted-foreground">{testResult}</span>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Phone delivery isn&apos;t set up yet: notifications are recorded
            here but not sent. It goes through your own ntfy server, configured
            in the server&apos;s config.yaml (notifications.ntfy).
          </p>
        ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
