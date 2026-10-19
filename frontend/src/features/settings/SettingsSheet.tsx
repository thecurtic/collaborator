import {
  BookOpen,
  ChevronRight,
  Loader2,
  LogOut,
  Smartphone,
  UserRound,
  Wallet,
  Volume2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import { synthesize } from '@/features/voice/piperTts';
import { SPEECH_RATE } from '@/features/voice/speechUtils';
import { ApiRequestError, request } from '@/api/http';
import { Button } from '@/components/ui/button';
import { useModalA11y } from '@/lib/useModalA11y';
import { NotificationsSection } from './NotificationsSection';
import { ProjectOverridesSection } from './ProjectOverridesSection';
import { useCapabilities } from '@/lib/capabilities';
import { KEYWORD_OPTIONS } from '@/features/voice/keywordSpotter';
import { PIPER_VOICES } from '@/features/voice/piperVoices';
import { webSpeechSupported } from '@/features/voice/speech';
import { cn, parseApiDate } from '@/lib/utils';
import type { DeviceSession, ModelsInfo, TtsVoices } from '@/domain/models';
import { currentLocation } from '@/lib/location';
import {
  DEFAULT_END_PHRASE,
  DEFAULT_INTERRUPT_PHRASE,
  setDebugEnabled,
  setEndPhrase,
  setEndWord,
  setInterruptPhrase,
  setLocationEnabled,
  setPiperVoice,
  setToolsEnabled,
  setServerVoice,
  setStopWord,
  setSttEngine,
  setTtsEngine,
  useDebugEnabled,
  useEndPhrase,
  useEndWord,
  useInterruptPhrase,
  useLocationEnabled,
  usePiperVoice,
  useToolsEnabled,
  useServerVoice,
  useStopWord,
  useSttEngine,
  useTtsEngine,
} from './uiPrefs';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Push the Profile screen (the USER hub and its satellites). */
  onOpenProfile: () => void;
  /** Push the References screen (the prompts the model is shown). */
  onOpenReferences: () => void;
  /** Push the Wallet screen (Collaborator's own wallet: top up, take out). */
  onOpenWallet: () => void;
}

/** A row that leaves the sheet for a pushed screen. */
function PageRow({ icon: Icon, label, hint, onClick }: {
  icon: typeof BookOpen; label: string; hint: string; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
            className="flex w-full items-center gap-3 rounded-lg px-1 py-2.5 text-left hover:bg-muted/60 active:bg-muted">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

interface VisionStatus {
  chat_model: string | null;
  chat_model_sees: boolean;
  setting: string | boolean;
  model: string | null;
  lmstudio_type?: string | null;
  ok?: boolean;
  answer?: string;
  error?: string;
}

/**
 * Whether the chat model reads images (attachments, scanned pages and
 * screenshots all rely on it), with a one-tap proof: a card with a known
 * word goes to the model and its answer comes back.
 */
function VisionCheck() {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<VisionStatus | null>(null);

  useEffect(() => {
    request<VisionStatus>('/api/vision').then(setStatus).catch(() => setStatus(null));
  }, []);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await request<VisionStatus>('/api/vision/test', { method: 'POST' });
      setResult(r);
      setStatus(r);
    } catch (err) {
      setResult({ ...(status as VisionStatus), ok: false,
                  error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  let line = 'Checking whether it reads images…';
  if (status) {
    if (status.chat_model_sees) line = 'Reads images: attachments and screenshots go to this model.';
    else if (status.lmstudio_type === 'llm')
      line = 'Text only: LM Studio loaded it without its vision part (mmproj). ' +
             'Images can’t be read until it loads as a vision model.';
    else line = 'Text only, as far as the server can tell. Images can’t be read.';
  }

  return (
    <div className="rounded-md bg-muted/60 px-2.5 py-2">
      <p className="text-xs text-muted-foreground">{line}</p>
      <button
        type="button"
        onClick={() => void test()}
        disabled={testing}
        className="mt-1 text-xs font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
      >
        {testing ? 'Testing… (the model may need to load)' : 'Test image reading'}
      </button>
      {result && (
        <p className={`mt-1 text-xs ${result.ok ? 'text-foreground' : 'text-destructive'}`}>
          {result.ok
            ? `✓ It read the test card: “${result.answer}”`
            : result.error
              ? result.error
              : `✗ It answered “${result.answer}” — the image didn’t get through.`}
        </p>
      )}
    </div>
  );
}

/**
 * Chat-model picker (server-backed, unlike the localStorage prefs below).
 * Mounted only while the sheet is open, so the fetch happens per open.
 */
function ModelPicker() {
  const [models, setModels] = useState<ModelsInfo | null>(null);
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
      setModels({
        current: '',
        available: [],
        models: [],
        loaded: [],
        currentLoaded: null,
      });
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
      await load(); // re-derive current_loaded for the new selection
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch model');
      if (err instanceof ApiRequestError && err.status === 422) setForceable(id);
    } finally {
      setBusy(false);
    }
  };

  // Prefer the enriched rows (f7e235b): chat models only, with load state.
  // Fall back to the plain id list on non-LM-Studio endpoints.
  const loadedSet = new Set(models?.loaded ?? []);
  const chatIds =
    models && models.models.length > 0
      ? models.models
          // vlm = vision-capable chat model — very much a chat option.
          .filter((m) => !m.type || m.type === 'llm' || m.type === 'vlm')
          .map((m) => m.id)
      : (models?.available ?? []);
  // Keep the current model selectable even if LM Studio doesn't list it.
  const options =
    models && models.current && !chatIds.includes(models.current)
      ? [models.current, ...chatIds]
      : chatIds;
  const currentInfo = models?.models.find((m) => m.id === models.current);

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
                {loadedSet.has(m) ? ' — loaded ●' : ''}
              </option>
            ))}
          </select>
          {/* The near-crash case: config points at a model LM Studio hasn't
              loaded — the next message loads it (slow, memory-heavy). */}
          {models?.currentLoaded === false && (
            <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700">
              This model isn't loaded. Your next message will make LM Studio
              load it — slow, and memory-heavy if another large model is
              already resident
              {models.loaded.length > 0
                ? ` (currently loaded: ${models.loaded.join(', ')})`
                : ''}
              .
            </p>
          )}
          {currentInfo && (
            <p className="text-xs text-muted-foreground">
              {[
                currentInfo.quantization,
                currentInfo.maxContextLength != null
                  ? `${Math.round(currentInfo.maxContextLength / 1024)}k context`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
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
          <VisionCheck key={models.current} />
        </>
      )}
    </div>
  );
}

const PREVIEW_TEXT =
  "Here's a quick preview — this is how I'll sound when reading replies aloud.";

/**
 * One-at-a-time voice preview: picking a voice speaks a sample sentence so
 * you hear it before committing. Sequenced so a rapid second pick cancels
 * the first; object URLs are revoked on stop/unmount.
 */
function useVoicePreview() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const stop = useCallback(() => {
    seqRef.current++;
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setStatus('idle');
  }, []);

  useEffect(() => stop, [stop]); // sheet closed mid-preview

  const play = useCallback(
    (synth: () => Promise<Blob>) => {
      stop();
      const seq = ++seqRef.current;
      setStatus('loading');
      synth()
        .then((blob) => {
          if (seqRef.current !== seq) return;
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          const audio = new Audio(url);
          audio.playbackRate = SPEECH_RATE; // match real read-aloud pacing
          audioRef.current = audio;
          audio.onended = () => {
            if (seqRef.current === seq) stop();
          };
          audio.onerror = () => {
            if (seqRef.current === seq) stop();
          };
          setStatus('playing');
          void audio.play().catch(() => {
            if (seqRef.current === seq) stop();
          });
        })
        .catch(() => {
          if (seqRef.current === seq) setStatus('idle');
        });
    },
    [stop],
  );

  return { status, play };
}

/** Inline status line under a voice picker while its preview runs. */
function PreviewStatus({ status }: { status: 'idle' | 'loading' | 'playing' }) {
  if (status === 'idle') return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status === 'loading' ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" /> Preparing preview… (a
          first use may download the voice)
        </>
      ) : (
        <>
          <Volume2 className="h-3 w-3" /> Playing preview
        </>
      )}
    </p>
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
  const preview = useVoicePreview();

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
    <div className="space-y-1.5">
      <label className="block">
        <span className="text-xs text-muted-foreground">Server voice</span>
        <select
          value={serverVoice}
          onChange={(e) => {
            const v = e.target.value;
            setServerVoice(v);
            // Hear it immediately — that's how you pick a voice.
            preview.play(() =>
              api.synthesizeSpeech(PREVIEW_TEXT, v || undefined),
            );
          }}
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
      <PreviewStatus status={preview.status} />
    </div>
  );
}

/**
 * Logged-in devices (b60da69) — the lost-phone story: see every session,
 * revoke any other one instantly. Revokes are optimistic per house style.
 */
function DevicesSection() {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions(await api.listSessions());
    } catch (err) {
      // Auth disabled (local dev) or older backend: keep the section quiet.
      setError(err instanceof Error ? err.message : 'Could not load devices');
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = (s: DeviceSession) => {
    setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? null);
    api.revokeSession(s.id).catch(() => {
      setError(`Couldn't sign out "${s.label}" — try again.`);
      void load();
    });
  };

  const lastSeen = (s: DeviceSession) => {
    const d = parseApiDate(s.lastSeen);
    return d ? d.toLocaleString() : s.lastSeen;
  };

  if (sessions !== null && sessions.length === 0 && !error) return null;

  return (
    <div className="mt-5 space-y-3 border-t border-border pt-4">
      <p className="text-sm font-medium">Devices</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {sessions === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading devices…
        </p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5">
              <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm text-foreground">
                  <span className="truncate">{s.label}</span>
                  {s.current && (
                    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      this device
                    </span>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  last seen {lastSeen(s)}
                </span>
              </span>
              {!s.current && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Sign out ${s.label}`}
                  title="Sign this device out immediately"
                  onClick={() => revoke(s)}
                  className="h-8 w-8 shrink-0 text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Lost a device? Sign it out here and its session dies instantly.
      </p>
    </div>
  );
}

export function SettingsSheet({
  open,
  onClose,
  onOpenProfile,
  onOpenReferences,
  onOpenWallet,
}: SettingsSheetProps) {
  const debug = useDebugEnabled();
  const tools = useToolsEnabled();
  const location = useLocationEnabled();
  const ttsEngine = useTtsEngine();
  const sttEngine = useSttEngine();
  const piperVoice = usePiperVoice();
  const endWord = useEndWord();
  const stopWord = useStopWord();
  const endPhrase = useEndPhrase();
  const interruptPhrase = useInterruptPhrase();
  const caps = useCapabilities();
  const piperPreview = useVoicePreview();
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

        {/* What the model is shown about me and how it's instructed (UX
            doc, Destinations: Profile and References live in Settings). */}
        <div className="-mt-1 mb-4 border-b border-border pb-3">
          <PageRow icon={UserRound} label="Profile"
                   hint="What Collaborator knows about you"
                   onClick={() => { onClose(); onOpenProfile(); }} />
          <PageRow icon={BookOpen} label="References"
                   hint="The prompts the model is shown"
                   onClick={() => { onClose(); onOpenReferences(); }} />
          <PageRow icon={Wallet} label="Wallet"
                   hint="Top up Collaborator's wallet or take money out"
                   onClick={() => { onClose(); onOpenWallet(); }} />
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
            <div className="space-y-1.5">
              <label className="block">
                <span className="text-xs text-muted-foreground">Piper voice</span>
                <select
                  value={piperVoice}
                  onChange={(e) => {
                    setPiperVoice(e.target.value);
                    // synthesize() reads the pref just written; first use of a
                    // voice downloads its model (the status line says so).
                    piperPreview.play(() => synthesize(PREVIEW_TEXT));
                  }}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {PIPER_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <PreviewStatus status={piperPreview.status} />
            </div>
          )}
        </div>

        {/* Tools (agent mode) — renamed from "recall", which gated the whole
            tool loop (9aee10b). */}
        <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
          <div className="pr-3">
            <p className="text-sm font-medium">Tools (agent mode)</p>
            <p className="text-xs text-muted-foreground">
              Let the model use its tools: web search, page reading, your
              notes, and memory recall. Off = plain chat with no tool calls.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={tools}
            aria-label="Tools (agent mode)"
            onClick={() => setToolsEnabled(!tools)}
            className={cn(
              'relative h-6 w-11 shrink-0 rounded-full transition-colors',
              tools ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'block h-5 w-5 rounded-full bg-white transition-transform',
                tools ? 'translate-x-5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>

        {/* Location context (b23d8ea) — opt-in, per-turn, resolved to named
            places server-side; ephemeral unless the SERVER config stores it. */}
        <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
          <div className="pr-3">
            <p className="text-sm font-medium">Location context</p>
            <p className="text-xs text-muted-foreground">
              Attach your location to each message so the agent knows where
              you are ("at home", "near work"). Your server resolves the
              coordinates to named places — nothing leaves it, and by default
              nothing is stored.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={location}
            aria-label="Location context"
            onClick={() => {
              const next = !location;
              setLocationEnabled(next);
              // Surface the browser permission prompt now, not mid-send.
              if (next) void currentLocation();
            }}
            className={cn(
              'relative h-6 w-11 shrink-0 rounded-full transition-colors',
              location ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'block h-5 w-5 rounded-full bg-white transition-transform',
                location ? 'translate-x-5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>

        {/* Logged-in devices (hidden when auth is off / list is empty). */}
        <DevicesSection />

        {/* Server-backed, per user: which kinds notify (all optional). */}
        <NotificationsSection open={open} />

        {/* Project-name overrides, shown only when there are any. */}
        <ProjectOverridesSection open={open} />

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
