import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { ApiRequestError } from '@/api/http';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';
import { useCapabilities } from '@/lib/capabilities';
import { KEYWORD_OPTIONS } from '@/features/voice/keywordSpotter';
import { PIPER_VOICES } from '@/features/voice/piperVoices';
import { webSpeechSupported } from '@/features/voice/speech';
import { cn } from '@/lib/utils';
import type { TtsVoices } from '@/domain/models';
import {
  DEFAULT_END_PHRASE,
  DEFAULT_INTERRUPT_PHRASE,
  setDebugEnabled,
  setEndPhrase,
  setEndWord,
  setInterruptPhrase,
  setPiperVoice,
  setRecallEnabled,
  setServerVoice,
  setStopWord,
  setSttEngine,
  setTtsEngine,
  useDebugEnabled,
  useEndPhrase,
  useEndWord,
  useInterruptPhrase,
  usePiperVoice,
  useRecallEnabled,
  useServerVoice,
  useStopWord,
  useSttEngine,
  useTtsEngine,
} from './uiPrefs';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Chat-model picker (server-backed, unlike the localStorage prefs below).
 * Mounted only while the sheet is open, so the fetch happens per open.
 */
function ModelPicker() {
  const [models, setModels] = useState<{
    current: string;
    available: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A 422 target the user may push through with force (advanced action).
  const [forceable, setForceable] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setModels(await api.getModels());
    } catch (err) {
      // LM Studio may be down — the list endpoint 500s in that case.
      setError(err instanceof Error ? err.message : 'Could not load models');
      setModels({ current: '', available: [] });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTo = async (id: string, force = false) => {
    if (!id || !models || id === models.current) return;
    setBusy(true);
    setError(null);
    setForceable(null);
    try {
      await api.setModel(id, force);
      setModels({ ...models, current: id });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch model');
      if (err instanceof ApiRequestError && err.status === 422) setForceable(id);
    } finally {
      setBusy(false);
    }
  };

  // Keep the current model selectable even if LM Studio doesn't list it.
  const options =
    models && models.current && !models.available.includes(models.current)
      ? [models.current, ...models.available]
      : (models?.available ?? []);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Model</p>
      {models === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading models…
        </p>
      ) : (
        <>
          <select
            value={models.current}
            disabled={busy || options.length === 0}
            onChange={(e) => void switchTo(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {error && (
            <p className="text-xs text-destructive">
              {error}
              {forceable && (
                <button
                  type="button"
                  onClick={() => void switchTo(forceable, true)}
                  className="ml-2 underline underline-offset-2"
                >
                  Switch anyway
                </button>
              )}
              {!forceable && (
                <button
                  type="button"
                  onClick={() => void load()}
                  className="ml-2 underline underline-offset-2"
                >
                  Retry
                </button>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Applies to the very next message and persists. Note: this is
            per-install — it changes the model for every user, not just you.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Server TTS voice picker (shown only when the server engine is selected).
 * Fetched per open; '' = let the server use its configured default.
 */
function ServerVoicePicker() {
  const serverVoice = useServerVoice();
  const [roster, setRoster] = useState<TtsVoices | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getTtsVoices()
      .then(setRoster)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Could not load voices'),
      );
  }, []);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!roster) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading voices…
      </p>
    );
  }
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">Server voice</span>
      <select
        value={serverVoice}
        onChange={(e) => setServerVoice(e.target.value)}
        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">
          Server default{roster.defaultVoice ? ` (${roster.defaultVoice})` : ''}
        </option>
        {roster.voices.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const debug = useDebugEnabled();
  const recall = useRecallEnabled();
  const ttsEngine = useTtsEngine();
  const sttEngine = useSttEngine();
  const piperVoice = usePiperVoice();
  const endWord = useEndWord();
  const stopWord = useStopWord();
  const endPhrase = useEndPhrase();
  const interruptPhrase = useInterruptPhrase();
  const caps = useCapabilities();
  // Server phrase tier: commands are free-text phrases matched in the ASR
  // stream instead of the on-device keyword classifier's fixed vocabulary.
  const phraseTier = caps.phrases && sttEngine === 'server';

  // Focus trap + Escape-to-close + focus restore.
  const dialogRef = useModalA11y<HTMLDivElement>(open, onClose);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="pb-safe relative max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-card p-5 outline-none sm:max-w-md sm:rounded-2xl"
      >
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

        {/* Chat model (server-backed; applies immediately). */}
        <ModelPicker />

        {/* Voice commands — server phrases (free text, matched in the ASR
            transcript) or on-device keyword spotting (fixed vocabulary). */}
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Voice commands</p>
          {phraseTier ? (
            <>
              <p className="text-xs text-muted-foreground">
                Detected in the transcript on your server — only these exact
                phrases act; other speech and noise are ignored. Pick 2–4
                distinctive words you wouldn't say mid-thought. The microphone
                stays on while the assistant speaks so the stop phrase can
                interrupt it.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-muted-foreground">
                    End my turn (call mode)
                  </span>
                  <input
                    type="text"
                    value={endPhrase}
                    placeholder={DEFAULT_END_PHRASE}
                    onChange={(e) => setEndPhrase(e.target.value)}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted-foreground">
                    Stop speaking
                  </span>
                  <input
                    type="text"
                    value={interruptPhrase}
                    placeholder={DEFAULT_INTERRUPT_PHRASE}
                    onChange={(e) => setInterruptPhrase(e.target.value)}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Spoken on-device. Limited to recognizable command words. Note:
                the microphone stays on while the assistant reads aloud so the
                stop word can interrupt it — audio never leaves this device.
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
            </>
          )}
        </div>

        {/* Transcription (speech-to-text). */}
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Transcription (speech-to-text)</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={sttEngine === 'server' ? 'default' : 'outline'}
              size="sm"
              className="flex-1"
              onClick={() => setSttEngine('server')}
            >
              Server
            </Button>
            <Button
              type="button"
              variant={sttEngine === 'device' ? 'default' : 'outline'}
              size="sm"
              className="flex-1"
              onClick={() => setSttEngine('device')}
            >
              On-device
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {sttEngine === 'server'
              ? 'Audio is streamed to your server for transcription (Whisper).'
              : 'Transcribes on this device (Whisper-tiny, WebGPU when available). Audio never leaves the device; downloads the model once.'}
          </p>
        </div>

        {/* Voice (text-to-speech). */}
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Voice (text-to-speech)</p>
          <div className="flex gap-2">
            {caps.ttsStream && (
              <Button
                type="button"
                variant={ttsEngine === 'server' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => setTtsEngine('server')}
              >
                Server
              </Button>
            )}
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
            {ttsEngine === 'server'
              ? 'Synthesized on your server (Piper) and streamed here — fast start, no on-device downloads.'
              : ttsEngine === 'piper'
                ? 'Consistent neural voice, runs on-device (downloads the voice once; slower on phones).'
                : 'Instant on-device system voice; quality varies by device.'}
          </p>

          {ttsEngine === 'server' && caps.ttsStream && <ServerVoicePicker />}

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

        {/* Memory / recall. */}
        <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
          <div className="pr-3">
            <p className="text-sm font-medium">Memory (recall)</p>
            <p className="text-xs text-muted-foreground">
              Search past turns and inject relevant memories into context. Shown as
              a recall block above the reply.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={recall}
            aria-label="Memory recall"
            onClick={() => setRecallEnabled(!recall)}
            className={cn(
              'relative h-6 w-11 shrink-0 rounded-full transition-colors',
              recall ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'block h-5 w-5 rounded-full bg-white transition-transform',
                recall ? 'translate-x-5' : 'translate-x-0.5',
              )}
            />
          </button>
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
