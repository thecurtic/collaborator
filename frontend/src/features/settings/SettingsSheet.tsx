import { Loader2, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { setDebugEnabled, useDebugEnabled } from './uiPrefs';
import { useSettings } from './useSettings';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const { settings, status, error, saving, save } = useSettings(open);
  const debug = useDebugEnabled();
  const [endPhrase, setEndPhrase] = useState('');
  const [savedNote, setSavedNote] = useState(false);

  // Sync the field when settings load.
  useEffect(() => {
    if (settings) setEndPhrase(settings.voiceEndPhrase);
  }, [settings]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const phrase = endPhrase.trim();
    if (!phrase || saving) return;
    setSavedNote(false);
    const ok = await save({ voiceEndPhrase: phrase });
    if (ok) {
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 2000);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <button
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      {/* Sheet: bottom sheet on mobile, centered card on desktop */}
      <div className="pb-safe relative w-full rounded-t-2xl border border-border bg-card p-5 sm:max-w-md sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {status === 'loading' ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : status === 'error' ? (
          <p className="py-4 text-sm text-destructive">{error}</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-2">
            <label htmlFor="end-phrase" className="block text-sm font-medium">
              Voice end phrase
            </label>
            <p className="text-xs text-muted-foreground">
              Say this in call mode to finish your turn (e.g. “go ahead”).
            </p>
            <input
              id="end-phrase"
              value={endPhrase}
              onChange={(e) => setEndPhrase(e.target.value)}
              placeholder="go ahead"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center justify-end gap-3 pt-2">
              {savedNote && (
                <span className="text-xs text-muted-foreground">Saved ✓</span>
              )}
              <Button type="submit" disabled={saving || !endPhrase.trim()}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </form>
        )}

        {/* Client-side preference — independent of backend settings. */}
        <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
          <div>
            <p className="text-sm font-medium">Developer diagnostics</p>
            <p className="text-xs text-muted-foreground">
              Show the live debug log in call mode.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={debug}
            aria-label="Developer diagnostics"
            onClick={() => setDebugEnabled(!debug)}
            className={cn(
              'relative h-6 w-11 shrink-0 rounded-full transition-colors',
              debug ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'block h-5 w-5 rounded-full bg-white transition-transform',
                debug ? 'translate-x-5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
