import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import {
  getEndPhrase,
  getEndWord,
  getInterruptPhrase,
  getStopWord,
  getSttEngine,
  getToolsEnabled,
} from '@/features/settings/uiPrefs';
import { getCapabilities } from '@/lib/capabilities';
import { holdPwaUpdates } from '@/pwa';
import { currentLocation } from '@/lib/location';
import {
  startCallService,
  stopCallService,
  updateCallService,
} from '@/native/nativeShell';
import { saveTurnSources } from '@/features/chat/sourcesStore';
import { newStreamId, STOP_GRACE_MS } from '@/features/chat/useConversation';
import { foldToolEvent } from '@/features/chat/toolActivity';
import { withTimeout } from '@/lib/utils';
import type { ToolActivity, TurnAttachment } from '@/domain/models';
import { attachmentsApi } from '@/features/attachments/attachmentsApi';
import { chimeListenStart, chimeListenStop } from './chime';
import { DeviceTranscriber, resetDeviceWorker } from './deviceTranscriber';
import { listenForWords, warmUpKeywordSpotter } from './keywordSpotter';
import { startPcmStream, type PcmStream } from './pcmStreamer';
import type { BranchTarget } from '@/features/chat/branchTarget';
import type { CallIntro } from '@/features/chat/callIntro';
import { createSpeechSession, type SpeechSession } from './speech';
import { splitParagraphs, stripTrailingWord } from './speechUtils';
import { TranscriptionStream } from './transcriptionStream';

/** Common shape for server (WebSocket) and on-device (worker) transcribers. */
interface Transcriber {
  ready(): Promise<void>;
  sendPcm(buf: ArrayBuffer): void;
  end(): Promise<string>;
  close(): void;
}

export type CallPhase =
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'responding'
  | 'error';

export interface CallTurn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** User turns: what was handed over with it (files, text, links). */
  shared?: { files: TurnAttachment[]; texts: string[] };
}

/**
 * Something handed over mid-call (UX doc, Voice: a photo, a link or some
 * text without dropping out of voice). It rides along with the next thing
 * said: files as attachments, text and links appended to the message.
 */
export type Handover =
  | {
      key: number;
      kind: 'file';
      name: string;
      status: 'uploading' | 'ready' | 'failed';
      attachment?: TurnAttachment;
      upload: Promise<TurnAttachment | null>;
    }
  | { key: number; kind: 'text'; text: string };

/** A [start, end) char range of a turn's text that TTS could not speak. */
export interface FailedRange {
  turnId: number;
  start: number;
  end: number;
}

// Detection confidence. "stop" listens while the agent (and room noise) is
// audible, so it must be strict to avoid false interrupts that cut speech short.
const END_WORD_THRESHOLD = 0.85;
const STOP_WORD_THRESHOLD = 0.97;

interface Controls {
  endTurn: () => void;
  /** Manual barge-in — same effect as the stop word / interrupt phrase. */
  interruptNow: () => void;
  end: () => void;
  /** Mute / unmute the mic (the call stays up; it just hears silence). */
  setMuted: (muted: boolean) => void;
  retry: () => void;
  skipTo: (turnId: number, text: string, fromParagraph: number) => void;
}

/**
 * Call loop: listen (stream PCM16, show live partials) → on end-of-turn take
 * the final transcript → stream the reply and speak it → listen again.
 *
 * Turn control comes in two tiers:
 * - Server phrases (server STT + `phrases` capability, 9acc3d1): the end
 *   phrase is detected server-side in the ASR transcript; while the reply
 *   plays, a second WS session listens for the interrupt phrase. No TF.js.
 * - On-device keyword spotting (TF.js) otherwise: end word while listening,
 *   stop word while speaking.
 * The "Done" button always ends a turn regardless of tier.
 */
export function useCall(
  open: boolean,
  onClose: (saving?: Promise<void>) => void,
  branchTarget?: BranchTarget | null,
  activeLeafId?: number | null,
  onBranchConsumed?: () => void,
  onBranchCreated?: (parentTurnId: number) => void,
  onLeafChanged?: (leafId: number) => void,
  intro?: CallIntro | null,
  /** A note draft landed during this call — the app refreshes the badge. */
  onDraftsProposed?: () => void,
) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
  // Live chain-of-thought for the in-flight reply (545e1a5) — display-only,
  // never spoken, cleared whenever a new listen/speak segment starts.
  const [reasoning, setReasoning] = useState('');
  const [partial, setPartial] = useState('');
  const [transcript, setTranscript] = useState<CallTurn[]>([]);
  // Read-along: which transcript turn is being spoken, and how far.
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [spokenChars, setSpokenChars] = useState(0);
  const [speakBase, setSpeakBase] = useState(0);
  // Char ranges TTS failed to speak (rendered red so unread text is visible).
  const [failedRanges, setFailedRanges] = useState<FailedRange[]>([]);
  // Live tool activity for the current spoken turn (searches, page reads) —
  // visible in the call UI, persisted per turn for the Sources button.
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const activityRef = useRef<ToolActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [handover, setHandoverState] = useState<Handover[]>([]);
  const handoverRef = useRef<Handover[]>([]);
  const handoverKey = useRef(0);
  const setHandover = useCallback((next: Handover[]) => {
    handoverRef.current = next;
    setHandoverState(next);
  }, []);
  const [logs, setLogs] = useState<string[]>([]);
  const controlsRef = useRef<Controls | null>(null);
  // Read at call start; not effect deps so changing them won't restart the call.
  const branchTargetRef = useRef(branchTarget);
  branchTargetRef.current = branchTarget;
  const activeLeafIdRef = useRef(activeLeafId);
  activeLeafIdRef.current = activeLeafId;
  const onBranchConsumedRef = useRef(onBranchConsumed);
  onBranchConsumedRef.current = onBranchConsumed;
  const onBranchCreatedRef = useRef(onBranchCreated);
  onBranchCreatedRef.current = onBranchCreated;
  const onLeafChangedRef = useRef(onLeafChanged);
  onLeafChangedRef.current = onLeafChanged;
  const introRef = useRef(intro);
  introRef.current = intro;
  const onDraftsProposedRef = useRef(onDraftsProposed);
  onDraftsProposedRef.current = onDraftsProposed;
  // Notes proposed during this call — voice can't rely on the spoken
  // announcement (barge-in cuts it off), so the UI shows a persistent chip.
  const [draftCount, setDraftCount] = useState(0);

  useEffect(() => {
    if (!open) return;

    let active = true;
    // The first spoken turn forks from this branch (if one was pending), then
    // the loop continues normally on the new branch. `leafId` is the active
    // branch leaf to continue from; each turn updates it to the new turn's id.
    let pendingBranch: BranchTarget | null = branchTargetRef.current ?? null;
    // What to do before the first listen (typed draft / read-this-reply).
    const pendingIntro: CallIntro | null = introRef.current ?? null;
    let leafId: number | null = pendingBranch
      ? null
      : (activeLeafIdRef.current ?? null);
    let turnId = 0;
    const pushTurn = (role: CallTurn['role'], text: string): number => {
      turnId += 1;
      const id = turnId;
      setTranscript((prev) => [...prev, { id, role, text }]);
      return id;
    };
    const updateTurn = (id: number, text: string) =>
      setTranscript((prev) =>
        prev.map((t) => (t.id === id ? { ...t, text } : t)),
      );
    setTranscript([]);
    // Files lined up in the composer arrive already uploaded.
    const seeded: Handover[] =
      pendingIntro?.kind === 'send'
        ? (pendingIntro.attachments ?? []).map((a) => ({
            key: ++handoverKey.current,
            kind: 'file',
            name: a.filename,
            status: 'ready',
            attachment: a,
            upload: Promise.resolve(a),
          }))
        : [];
    handoverRef.current = seeded;
    setHandoverState(seeded);
    setDraftCount(0);
    setSpeakingId(null);
    setSpokenChars(0);
    setSpeakBase(0);
    setFailedRanges([]);
    setError(null);
    // Pause PWA update checks — an auto-update reload would drop the call.
    const releaseUpdateHold = holdPwaUpdates();
    // Mute = the mic track hears silence: the call, the transcriber and the
    // phrase listeners all stay up, they just get nothing to work with.
    let mutedNow = false;
    setMutedState(false);
    const applyMute = () =>
      stream?.getAudioTracks().forEach((t) => {
        t.enabled = !mutedNow;
      });
    const setMuted = (m: boolean) => {
      if (!active || m === mutedNow) return;
      mutedNow = m;
      applyMute();
      setMutedState(m);
      void updateCallService(m);
      log(m ? 'muted' : 'unmuted');
    };
    // Android shell: mic foreground service so capture survives screen-off
    // (no-op in browsers). Shows the persistent "call in progress" notice,
    // whose Hang up and Mute buttons drive the call from the shade.
    void startCallService({
      hangUp: () => controlsRef.current?.end(),
      toggleMute: () => setMuted(!mutedNow),
    });
    let stream: MediaStream | null = null;
    let pcm: PcmStream | null = null;
    let transcriber: Transcriber | null = null;
    let endWord = getEndWord();
    let stopWord = getStopWord();
    let endPhrase = getEndPhrase();
    let interruptPhrase = getInterruptPhrase();
    let queue: SpeechSession | null = null;
    let finalizing = false;
    let streamAbort: AbortController | null = null;
    // The reply in flight (its stream id) and the respond() still running.
    // A barge-in or hang-up STOPS the reply (the backend saves what was said
    // and ends the stream with its turn id) rather than cutting it, so the
    // call continues from that turn and the chat shows it on hang-up.
    let replyStreamId: string | null = null;
    let inflight: Promise<void> | null = null;
    const stopReply = () => {
      const id = replyStreamId;
      replyStreamId = null;
      if (!id) return;
      const abort = streamAbort;
      void api.stopStream(id).catch(() => abort?.abort());
      setTimeout(() => abort?.abort(), STOP_GRACE_MS); // no-op once it ended
    };
    // True while the CURRENT listen session uses server phrase detection —
    // the server strips the end phrase, so no client-side word stripping.
    let phraseMode = false;
    // Server tier: does this call use phrase detection instead of TF.js KWS?
    const usePhrases = () =>
      getSttEngine() === 'server' && getCapabilities().phrases;

    // Keyword listener management (one active at a time, token-guarded).
    let kwsStop: (() => void) | null = null;
    let kwsToken = 0;
    const stopKws = () => {
      kwsToken++;
      kwsStop?.();
      kwsStop = null;
    };
    const startKws = (
      words: string[],
      onMatch: (w: string) => void,
      threshold: number,
    ) => {
      const token = ++kwsToken;
      kwsStop?.();
      kwsStop = null;
      void listenForWords(
        words,
        (w) => {
          if (active && kwsToken === token) onMatch(w);
        },
        threshold,
      )
        .then((stop) => {
          if (!active || kwsToken !== token) {
            stop();
            return;
          }
          kwsStop = stop;
        })
        .catch((e) => log(`kws error: ${e instanceof Error ? e.message : e}`));
    };

    const log = (m: string) => {
      const t = new Date().toLocaleTimeString([], { hour12: false });
      setLogs((prev) => [...prev.slice(-13), `${t} ${m}`]);
    };

    const stopCapture = () => {
      pcm?.stop();
      pcm = null;
    };

    // Server phrase tier: while the reply plays, a second WS session watches
    // the mic for the interrupt phrase ("hold on") — the phrase-tier
    // replacement for stop-word KWS. Failure degrades to no voice interrupt
    // (tap-to-skip and Done still work); the reply keeps playing either way.
    let monitor: TranscriptionStream | null = null;
    let monitorPcm: PcmStream | null = null;
    const stopInterruptMonitor = () => {
      monitorPcm?.stop();
      monitorPcm = null;
      monitor?.close();
      monitor = null;
    };
    const startInterruptMonitor = async () => {
      if (!active || !stream) return;
      stopInterruptMonitor();
      const m = new TranscriptionStream(() => {}, {
        phrases: [{ kind: 'interrupt', text: interruptPhrase }],
        onPhrase: (kind) => {
          if (kind === 'interrupt' && active && monitor === m) {
            log(`interrupt phrase "${interruptPhrase}" → interrupt`);
            interrupt();
          }
        },
      });
      monitor = m;
      try {
        await withTimeout(m.ready(), 15_000, 'interrupt monitor timed out');
        if (!active || monitor !== m) {
          m.close();
          return;
        }
        monitorPcm = await startPcmStream(stream, (buf) => monitor?.sendPcm(buf));
      } catch (e) {
        log(`interrupt monitor FAIL: ${e instanceof Error ? e.message : e}`);
        if (monitor === m) monitor = null;
        m.close();
      }
    };

    const cleanup = () => {
      active = false;
      releaseUpdateHold();
      void stopCallService();
      stopKws();
      stopInterruptMonitor();
      stopReply();
      stopCapture();
      transcriber?.close();
      transcriber = null;
      queue?.stop();
      queue = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const onToolEvent = (e: Parameters<typeof foldToolEvent>[1]) => {
      if (!active) return;
      setActivity((prev) => {
        const next = foldToolEvent(prev, e);
        activityRef.current = next;
        return next;
      });
    };

    // Display-only chain-of-thought ticker (never spoken, never persisted).
    const onReasoning = (c: string) => {
      if (active) setReasoning((prev) => prev + c);
    };

    // Proposed drafts: count them for the call UI and poke the app badge —
    // the spoken announcement alone is lossy (interrupts eat it), which left
    // drafts invisible until an unrelated refresh hours later.
    const onDrafts = (drafts: unknown[]) => {
      if (!active || drafts.length === 0) return;
      setDraftCount((n) => n + drafts.length);
      onDraftsProposedRef.current?.();
    };

    const listen = async () => {
      if (!active || !stream) return;
      finalizing = false;
      setPartial('');
      setReasoning('');
      setActivity([]); // the next spoken turn gets a fresh feed
      activityRef.current = [];
      // Show a brief connecting state — don't signal "listening" until the socket
      // is open and PCM is actually flowing, or we'd drop the start of speech.
      setPhase('connecting');
      const device = getSttEngine() === 'device';
      phraseMode = usePhrases();
      try {
        const onPartial = (t: string) => {
          if (active && !finalizing) setPartial(t);
        };
        transcriber = device
          ? new DeviceTranscriber(onPartial)
          : new TranscriptionStream(
              onPartial,
              phraseMode
                ? {
                    phrases: [{ kind: 'end', text: endPhrase }],
                    onPhrase: (kind) => {
                      if (kind === 'end' && active) {
                        log(`end phrase "${endPhrase}" → finish`);
                        void finalize();
                      }
                    },
                  }
                : {},
            );
        // Never hang in "connecting" — fail into the error phase, where the
        // Try again button re-runs listen() with a fresh transcriber.
        await withTimeout(
          transcriber.ready(),
          device ? 60_000 : 15_000,
          'speech engine start timed out',
        );
        if (!active) {
          transcriber.close();
          transcriber = null;
          return;
        }
        pcm = await startPcmStream(stream, (buf) => transcriber?.sendPcm(buf));
      } catch (e) {
        transcriber?.close();
        transcriber = null;
        // A hung device worker would hang every retry — rebuild it next time.
        if (device) resetDeviceWorker();
        if (!active) return;
        log(`stream start FAIL: ${e instanceof Error ? e.message : e}`);
        setPhase('error');
        setError('Could not open the transcription stream. Try again.');
        return;
      }
      if (!active) {
        stopCapture();
        return;
      }
      setPhase('listening');
      chimeListenStart(); // audible: mic now listening
      // No auto-timeout — the turn ends only on the end phrase/word or the
      // Done button (thinking pauses never end a turn).
      if (!phraseMode) {
        startKws(
          [endWord],
          () => {
            log(`end word "${endWord}" → finish`);
            void finalize();
          },
          END_WORD_THRESHOLD,
        );
      }
    };

    const finalize = async () => {
      if (!active || finalizing) return;
      finalizing = true;
      chimeListenStop(); // audible: mic stopped listening
      setPhase('processing'); // brief — final is usually ready immediately
      stopKws();
      stopCapture(); // stop sending audio before asking for the final
      let text = '';
      try {
        text = (await transcriber?.end()) ?? '';
      } catch (e) {
        log(`transcribe FAIL: ${e instanceof Error ? e.message : e}`);
      }
      transcriber?.close();
      transcriber = null;
      if (!active) return;
      // Phrase tier: the server already stripped the end phrase from `final`.
      const clean = phraseMode ? text.trim() : stripTrailingWord(text, endWord);
      log(`heard(${text.trim().length}) → "${clean.slice(0, 40)}"`);
      // A hand-over goes even with nothing said ("Send now").
      if (clean || handoverRef.current.length) {
        await respond(clean);
      } else {
        void listen(); // nothing intelligible — listen again
      }
    };

    // Speaking finished naturally → resume listening.
    const onSpeechIdle = () => {
      if (!active) return;
      setSpeakingId(null);
      setSpokenChars(0);
      setSpeakBase(0);
      stopKws();
      stopInterruptMonitor();
      void listen();
    };

    // Speech session that reports read-along progress and marks any sentence
    // TTS couldn't speak (rendered red). `base` = char offset playback started
    // from, so failed ranges land at the right spot in the full turn text.
    const makeSession = (turnId: number, base: number): SpeechSession => {
      setFailedRanges((prev) => prev.filter((r) => r.turnId !== turnId));
      return createSpeechSession(
        onSpeechIdle,
        (chars) => {
          if (active) setSpokenChars(chars);
        },
        (start, end) => {
          if (!active) return;
          log(`tts FAIL: chars ${base + start}–${base + end} not spoken`);
          setFailedRanges((prev) => [
            ...prev,
            { turnId, start: base + start, end: base + end },
          ]);
        },
      );
    };

    const respond = async (text: string) => {
      // One reply at a time: a stopped one finishes saving first, so this
      // turn continues from it.
      const prior = inflight;
      let release = () => {};
      const mine = new Promise<void>((r) => (release = r));
      inflight = mine;
      try {
        if (prior) await prior;
        await respondNow(text);
      } finally {
        release();
        if (inflight === mine) inflight = null;
      }
    };

    const respondNow = async (text: string) => {
      if (!active) return;
      log(`responding to: "${text.slice(0, 40)}"`);
      // Whatever was handed over goes with this turn.
      const handed = handoverRef.current;
      setHandover([]);
      const files = (
        await Promise.all(
          handed.map((h) => (h.kind === 'file' ? h.upload : Promise.resolve(null))),
        )
      ).filter((a): a is TurnAttachment => a !== null);
      const texts = handed.flatMap((h) => (h.kind === 'text' ? [h.text] : []));
      if (!active) return;
      const message = [text, ...texts].join('\n\n');
      const attachmentIds = files.map((f) => f.id);
      const uid = pushTurn('user', text); // user's turn joins the transcript
      if (files.length || texts.length) {
        log(`handed over: ${files.length} file(s), ${texts.length} text(s)`);
        setTranscript((prev) =>
          prev.map((t) => (t.id === uid ? { ...t, shared: { files, texts } } : t)),
        );
      }
      const aid = pushTurn('assistant', ''); // grows as the reply streams
      setPartial('');
      setReasoning('');
      setSpeakingId(aid);
      setSpeakBase(0);
      setSpokenChars(0);
      setPhase('responding');
      queue = makeSession(aid, 0);
      // Barge-in while the assistant speaks: interrupt phrase (server tier)
      // or stop-word KWS (on-device tier, strict threshold so the agent's own
      // audio / room noise doesn't false-trigger).
      if (usePhrases()) {
        void startInterruptMonitor();
      } else {
        startKws(
          [stopWord],
          () => {
            log(`stop word "${stopWord}" → interrupt`);
            interrupt();
          },
          STOP_WORD_THRESHOLD,
        );
      }
      streamAbort = new AbortController();
      const streamId = newStreamId();
      replyStreamId = streamId;
      // Capture this turn's session: tap-to-skip reassigns `queue`, and the
      // still-streaming reply must not push tokens into the new session.
      const session = queue;
      let full = '';
      const onToken = (c: string) => {
        if (replyStreamId !== streamId) return; // stopped: keep what was shown
        full += c;
        updateTurn(aid, full);
        session?.push(c);
      };
      try {
        if (pendingBranch) {
          const pb = pendingBranch;
          pendingBranch = null; // only the first turn forks
          onBranchConsumedRef.current?.();
          log(`branching from turn ${pb.turnId}`);
          const res = await api.branchMessage(
            {
              parentTurnId: pb.turnId,
              message,
              attachmentIds,
              // A call has no tap-or-hold: a recording handed over is
              // there to be heard, so it's transcribed.
              transcribe: true,
              paragraphIndex: pb.paragraphIndex,
              commit: true,
              mode: 'voice',
              // Tools (web/notes/recall) on voice turns — same toggle as text.
              tools: getToolsEnabled(),
              location: await currentLocation(),
              streamId,
            },
            { onToken, onReasoning, onStatus: onToolEvent, onDrafts },
            streamAbort.signal,
          );
          if (res.id != null) {
            leafId = res.id; // continue off the new branch
            saveTurnSources(res.id, activityRef.current);
            onLeafChangedRef.current?.(res.id);
          }
          // Graduation signal: the app promotes the seed this forked from.
          onBranchCreatedRef.current?.(pb.turnId);
        } else {
          const res = await api.sendMessageStream(
            {
              message,
              attachmentIds,
              transcribe: true,
              parentTurnId: leafId ?? undefined, // continue the in-view branch
              commit: true,
              mode: 'voice',
              // Tools (web/notes/recall) on voice turns — same toggle as text.
              tools: getToolsEnabled(),
              location: await currentLocation(),
              streamId,
            },
            // Other voice event rendering is server-side (spoken citations,
            // drafts announced verbally); tool activity shows in the call UI.
            { onToken, onReasoning, onStatus: onToolEvent, onDrafts },
            streamAbort.signal,
          );
          if (res.id != null) {
            leafId = res.id;
            saveTurnSources(res.id, activityRef.current);
            onLeafChangedRef.current?.(res.id);
          }
        }
        // A stopped reply's session was already cut off; don't flush it.
        if (replyStreamId === streamId) session?.finish();
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (!aborted && active) {
          queue?.stop();
          stopKws();
          stopInterruptMonitor();
          setError(err instanceof Error ? err.message : 'Something went wrong.');
          setPhase('error');
        }
        // aborted (barge-in): interrupt() handles the loop; reply text is kept
      } finally {
        if (replyStreamId === streamId) replyStreamId = null;
      }
    };

    const interrupt = () => {
      stopKws();
      stopInterruptMonitor();
      stopReply();
      queue?.stop();
      queue = null;
      setSpeakingId(null);
      setSpokenChars(0);
      setSpeakBase(0);
      if (active) void listen();
    };

    // Tap-to-skip/replay: re-speak an assistant turn from a given paragraph.
    const speakFrom = (turnId: number, text: string, fromParagraph: number) => {
      if (!active) return;
      const infos = splitParagraphs(text);
      const idx = Math.max(0, Math.min(fromParagraph, infos.length - 1));
      const base = infos[idx]?.start ?? 0;
      const slice = text.slice(base).trim();
      if (!slice) return;
      log(`skip → ¶${fromParagraph}`);
      stopKws();
      stopInterruptMonitor();
      stopCapture();
      transcriber?.close();
      transcriber = null;
      queue?.stop();
      setPartial('');
      setReasoning('');
      setSpeakingId(turnId);
      setSpeakBase(base);
      setSpokenChars(0);
      setPhase('responding');
      queue = makeSession(turnId, base);
      if (usePhrases()) {
        void startInterruptMonitor();
      } else {
        startKws(
          [stopWord],
          () => {
            log(`stop word "${stopWord}" → interrupt`);
            interrupt();
          },
          STOP_WORD_THRESHOLD,
        );
      }
      queue.push(slice);
      queue.finish();
    };

    // Intro 'speak': read an existing reply aloud (per-message call button),
    // then fall into the normal listen loop via onSpeechIdle. Mirrors
    // speakFrom, but the reply first joins this call's transcript.
    const speakIntro = (text: string) => {
      const aid = pushTurn('assistant', text);
      setSpeakingId(aid);
      setSpeakBase(0);
      setSpokenChars(0);
      setPhase('responding');
      queue = makeSession(aid, 0);
      if (usePhrases()) {
        void startInterruptMonitor();
      } else {
        startKws(
          [stopWord],
          () => {
            log(`stop word "${stopWord}" → interrupt`);
            interrupt();
          },
          STOP_WORD_THRESHOLD,
        );
      }
      queue.push(text);
      queue.finish();
    };

    const init = async () => {
      try {
        endWord = getEndWord();
        stopWord = getStopWord();
        endPhrase = getEndPhrase();
        interruptPhrase = getInterruptPhrase();
        log(
          usePhrases()
            ? `phrases end="${endPhrase}" interrupt="${interruptPhrase}"`
            : `end="${endWord}" stop="${stopWord}"`,
        );
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Microphone not supported in this browser.');
        }
        stream = await navigator.mediaDevices.getUserMedia({
          // echoCancellation also keeps server TTS playback out of the
          // interrupt-monitor mic stream (the ASR must not hear the agent).
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
          return;
        }
        applyMute();
        if (!usePhrases()) {
          try {
            await warmUpKeywordSpotter(); // preload model so detection is instant
          } catch (e) {
            log(`keyword model failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (!active) return;
        log('ready (streaming PCM16 16k)');
        if (pendingIntro?.kind === 'send') {
          // The typed draft IS the first turn — respond to it right away.
          // Files alone go straight to the model too, with no words added.
          log(`intro: sending typed draft (${pendingIntro.text.length} chars)`);
          void respond(pendingIntro.text);
        } else if (pendingIntro?.kind === 'speak') {
          log('intro: reading the selected reply aloud');
          speakIntro(pendingIntro.text);
        } else {
          void listen();
        }
      } catch (err) {
        if (!active) return;
        setPhase('error');
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Microphone permission denied.'
            : err instanceof Error
              ? err.message
              : 'Could not start the call.',
        );
      }
    };

    controlsRef.current = {
      endTurn: () => {
        log('Done tapped');
        void finalize();
      },
      interruptNow: () => {
        log('Speak now tapped → interrupt');
        interrupt();
      },
      end: () => {
        // Close at once; `saving` settles when a reply that was cut off is
        // saved (the app reloads the chat after it, in the background).
        const saving = inflight ?? undefined;
        cleanup();
        onClose(saving);
      },
      setMuted,
      // Recover from an error without ending the call: if the mic is still
      // alive just listen again; otherwise redo the full startup.
      retry: () => {
        if (!active) return;
        log('retry tapped');
        setError(null);
        if (stream) void listen();
        else void init();
      },
      skipTo: speakFrom,
    };

    void init();

    return () => cleanup();
  }, [open, onClose]);

  const endTurn = useCallback(() => controlsRef.current?.endTurn(), []);
  const interruptNow = useCallback(
    () => controlsRef.current?.interruptNow(),
    [],
  );
  const end = useCallback(() => controlsRef.current?.end(), []);
  const setMuted = useCallback(
    (m: boolean) => controlsRef.current?.setMuted(m),
    [],
  );
  const retry = useCallback(() => controlsRef.current?.retry(), []);
  const skipTo = useCallback(
    (turnId: number, text: string, fromParagraph: number) =>
      controlsRef.current?.skipTo(turnId, text, fromParagraph),
    [],
  );

  /** Hand over files: each uploads now, and goes with the next turn. */
  const addFiles = useCallback(
    (list: File[]) => {
      const added: Handover[] = list.map((file) => {
        const key = ++handoverKey.current;
        const upload = attachmentsApi
          .upload(file, file.name || 'file')
          .then((a): TurnAttachment => {
            const att = { id: a.id, filename: a.filename, mime: a.mime, kind: a.kind, size: a.size };
            setHandover(
              handoverRef.current.map((h) =>
                h.key === key && h.kind === 'file' ? { ...h, status: 'ready', attachment: att } : h,
              ),
            );
            return att;
          })
          .catch(() => {
            setHandover(
              handoverRef.current.map((h) =>
                h.key === key && h.kind === 'file' ? { ...h, status: 'failed' } : h,
              ),
            );
            return null;
          });
        return { key, kind: 'file', name: file.name || 'file', status: 'uploading', upload };
      });
      setHandover([...handoverRef.current, ...added]);
    },
    [setHandover],
  );

  /** Hand over text or a link (pasted). */
  const addText = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      setHandover([...handoverRef.current, { key: ++handoverKey.current, kind: 'text', text: t }]);
    },
    [setHandover],
  );

  /** Take something back before it's sent (an unsent upload is discarded). */
  const removeHandover = useCallback(
    (key: number) => {
      const item = handoverRef.current.find((h) => h.key === key);
      setHandover(handoverRef.current.filter((h) => h.key !== key));
      if (item?.kind === 'file') {
        void item.upload.then((a) => a && attachmentsApi.remove(a.id).catch(() => {}));
      }
    },
    [setHandover],
  );

  return {
    phase,
    reasoning,
    handover,
    addFiles,
    addText,
    removeHandover,
    draftCount,
    partial,
    transcript,
    speakingId,
    spokenChars,
    speakBase,
    failedRanges,
    activity,
    error,
    muted,
    logs,
    endTurn,
    interruptNow,
    end,
    setMuted,
    retry,
    skipTo,
  };
}
