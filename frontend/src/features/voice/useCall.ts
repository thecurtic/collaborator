import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import {
  getEndPhrase,
  getEndWord,
  getInterruptPhrase,
  getRecallEnabled,
  getStopWord,
  getSttEngine,
} from '@/features/settings/uiPrefs';
import { getCapabilities } from '@/lib/capabilities';
import { holdPwaUpdates } from '@/pwa';
import { startCallService, stopCallService } from '@/native/nativeShell';
import { saveTurnSources } from '@/features/chat/sourcesStore';
import { foldToolEvent } from '@/features/chat/toolActivity';
import { withTimeout } from '@/lib/utils';
import type { ToolActivity } from '@/domain/models';
import { chimeListenStart, chimeListenStop } from './chime';
import { DeviceTranscriber, resetDeviceWorker } from './deviceTranscriber';
import { listenForWords, warmUpKeywordSpotter } from './keywordSpotter';
import { startPcmStream, type PcmStream } from './pcmStreamer';
import type { BranchTarget } from '@/features/chat/branchTarget';
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
}

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
  end: () => void;
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
  onClose: () => void,
  branchTarget?: BranchTarget | null,
  activeLeafId?: number | null,
  onBranchConsumed?: () => void,
  onBranchCreated?: (parentTurnId: number) => void,
) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
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

  useEffect(() => {
    if (!open) return;

    let active = true;
    // The first spoken turn forks from this branch (if one was pending), then
    // the loop continues normally on the new branch. `leafId` is the active
    // branch leaf to continue from; each turn updates it to the new turn's id.
    let pendingBranch: BranchTarget | null = branchTargetRef.current ?? null;
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
    setSpeakingId(null);
    setSpokenChars(0);
    setSpeakBase(0);
    setFailedRanges([]);
    setError(null);
    // Pause PWA update checks — an auto-update reload would drop the call.
    const releaseUpdateHold = holdPwaUpdates();
    // Android shell: mic foreground service so capture survives screen-off
    // (no-op in browsers). Shows the persistent "call in progress" notice.
    void startCallService();
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
      streamAbort?.abort();
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

    const listen = async () => {
      if (!active || !stream) return;
      finalizing = false;
      setPartial('');
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
      if (clean) {
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
      if (!active) return;
      log(`responding to: "${text.slice(0, 40)}"`);
      pushTurn('user', text); // user's turn joins the transcript
      const aid = pushTurn('assistant', ''); // grows as the reply streams
      setPartial('');
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
      // Capture this turn's session: tap-to-skip reassigns `queue`, and the
      // still-streaming reply must not push tokens into the new session.
      const session = queue;
      let full = '';
      const onToken = (c: string) => {
        full += c;
        updateTurn(aid, full);
        session?.push(c);
      };
      try {
        if (pendingBranch) {
          const pb = pendingBranch;
          pendingBranch = null; // only the first turn forks
          onBranchConsumedRef.current?.();
          log(`branching from turn ${pb.turnId}${pb.withContext ? '' : ' (no ctx)'}`);
          const res = await api.branchMessage(
            {
              parentTurnId: pb.turnId,
              message: text,
              paragraphIndex: pb.paragraphIndex,
              commit: true,
              mode: 'voice',
              // Tools (web/notes/recall) on voice turns — same toggle as text.
              recall: getRecallEnabled(),
              ...(pb.withContext ? {} : { contextTurns: 0 }),
            },
            { onToken, onStatus: onToolEvent },
            streamAbort.signal,
          );
          if (res.id != null) {
            leafId = res.id; // continue off the new branch
            saveTurnSources(res.id, activityRef.current);
          }
          // Graduation signal: the app promotes the seed this forked from.
          onBranchCreatedRef.current?.(pb.turnId);
        } else {
          const res = await api.sendMessageStream(
            {
              message: text,
              parentTurnId: leafId ?? undefined, // continue the in-view branch
              commit: true,
              mode: 'voice',
              // Tools (web/notes/recall) on voice turns — same toggle as text.
              recall: getRecallEnabled(),
            },
            // Other voice event rendering is server-side (spoken citations,
            // drafts announced verbally); tool activity shows in the call UI.
            { onToken, onStatus: onToolEvent },
            streamAbort.signal,
          );
          if (res.id != null) {
            leafId = res.id;
            saveTurnSources(res.id, activityRef.current);
          }
        }
        session?.finish();
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
      }
    };

    const interrupt = () => {
      stopKws();
      stopInterruptMonitor();
      streamAbort?.abort();
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
        if (!usePhrases()) {
          try {
            await warmUpKeywordSpotter(); // preload model so detection is instant
          } catch (e) {
            log(`keyword model failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (!active) return;
        log('ready (streaming PCM16 16k)');
        void listen();
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
      end: () => {
        cleanup();
        onClose();
      },
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
  const end = useCallback(() => controlsRef.current?.end(), []);
  const retry = useCallback(() => controlsRef.current?.retry(), []);
  const skipTo = useCallback(
    (turnId: number, text: string, fromParagraph: number) =>
      controlsRef.current?.skipTo(turnId, text, fromParagraph),
    [],
  );

  return {
    phase,
    partial,
    transcript,
    speakingId,
    spokenChars,
    speakBase,
    failedRanges,
    activity,
    error,
    logs,
    endTurn,
    end,
    retry,
    skipTo,
  };
}
