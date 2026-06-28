import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KEYWORD_OPTIONS } from '@/features/voice/keywordSpotter';
import { PIPER_VOICES } from '@/features/voice/piperVoices';
import { webSpeechSupported } from '@/features/voice/speech';
import { cn } from '@/lib/utils';
import {
  setDebugEnabled,
  setEndWord,
  setPiperVoice,
  setStopWord,
  setTtsEngine,
  useDebugEnabled,
  useEndWord,
  usePiperVoice,
  useStopWord,
  useTtsEngine,
} from './uiPrefs';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const debug = useDebugEnabled();
  const ttsEngine = useTtsEngine();
  const piperVoice = usePiperVoice();
  const endWord = useEndWord();
  const stopWord = useStopWord();

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="pb-safe relative max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-5 sm:max-w-md sm:rounded-2xl">
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

        {/* Voice commands — on-device keyword spotting (fixed vocabulary). */}
        <div className="space-y-3">
          <p className="text-sm font-medium">Voice commands</p>
          <p className="text-xs text-muted-foreground">
            Spoken on-device. Limited to recognizable command words.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted-foreground">
                End my turn (call mode)
              </span>
              <select
                value={endWord}
                onChange={(e) => setEndWord(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {KEYWORD_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">
                Stop speaking
              </span>
              <select
                value={stopWord}
                onChange={(e) => setStopWord(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {KEYWORD_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Voice (text-to-speech). */}
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Voice (text-to-speech)</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={ttsEngine === 'piper' ? 'default' : 'outline'}
              size="sm"
              className="flex-1"
              onClick={() => setTtsEngine('piper')}
            >
              Piper (neural)
            </Button>
            <Button
              type="button"
              variant={ttsEngine === 'browser' ? 'default' : 'outline'}
              size="sm"
              className="flex-1"
              onClick={() => setTtsEngine('browser')}
              disabled={!webSpeechSupported()}
            >
              Browser
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {ttsEngine === 'piper'
              ? 'Consistent neural voice, runs on-device (downloads the voice once; slower on phones).'
              : 'Instant on-device system voice; quality varies by device.'}
          </p>

          {ttsEngine === 'piper' && (
            <label className="block">
              <span className="text-xs text-muted-foreground">Piper voice</span>
              <select
                value={piperVoice}
                onChange={(e) => setPiperVoice(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {PIPER_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {/* Client-side preference. */}
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
