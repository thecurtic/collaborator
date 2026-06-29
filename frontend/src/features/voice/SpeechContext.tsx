import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getStopWord, getTtsEngine } from '@/features/settings/uiPrefs';
import { listenForWords } from './keywordSpotter';
import { downloadVoice, isVoiceStored } from './piperTts';
import { createSpeechSession, webSpeechSupported } from './speech';
import { splitParagraphs, type SpeechSession } from './speechUtils';

export type SpeechStatus = 'idle' | 'preparing' | 'speaking';

interface SpeechValue {
  /** Id of the turn currently being spoken/loaded, or null. */
  activeId: number | null;
  status: SpeechStatus;
  /** Piper voice-model download progress (0..1) while `status === 'preparing'`. */
  progress: number;
  /** Cumulative original characters spoken (read-along), relative to speakBase. */
  spokenChars: number;
  /** Char offset the current playback started from (tap-to-skip). */
  speakBase: number;
  supported: boolean;
  /** Speak the text for a turn id; clicking the active one stops it. */
  toggle: (id: number, text: string) => void;
  /** (Re)speak a turn from a given paragraph (tap-to-skip / replay). */
  speakFrom: (id: number, text: string, fromParagraph: number) => void;
  stop: () => void;
}

const SpeechContext = createContext<SpeechValue | null>(null);

const supported = typeof Worker !== 'undefined' || webSpeechSupported();

export function SpeechProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [status, setStatus] = useState<SpeechStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [spokenChars, setSpokenChars] = useState(0);
  const [speakBase, setSpeakBase] = useState(0);
  const sessionRef = useRef<SpeechSession | null>(null);
  const kwsStopRef = useRef<(() => void) | null>(null);
  const reqRef = useRef(0);

  const reset = useCallback(() => {
    // Stop the stop-word listener (mic on only while speaking).
    kwsStopRef.current?.();
    kwsStopRef.current = null;
    setActiveId(null);
    setStatus('idle');
    setProgress(0);
    setSpokenChars(0);
    setSpeakBase(0);
  }, []);

  const stop = useCallback(() => {
    reqRef.current++;
    sessionRef.current?.stop();
    sessionRef.current = null;
    reset();
  }, [reset]);

  // Speak fullText from a character offset; reports read-along relative to base.
  const startSpeaking = useCallback(
    (id: number, fullText: string, base: number) => {
      const req = ++reqRef.current;
      sessionRef.current?.stop();
      sessionRef.current = null;
      kwsStopRef.current?.();
      kwsStopRef.current = null;
      setActiveId(id);
      setProgress(0);
      setSpokenChars(0);
      setSpeakBase(base);

      void (async () => {
        try {
          // Only Piper needs a model download; Web Speech is instant.
          if (getTtsEngine() === 'piper' && !(await isVoiceStored())) {
            if (reqRef.current !== req) return;
            setStatus('preparing');
            await downloadVoice((f) => {
              if (reqRef.current === req) setProgress(f);
            });
          }
          if (reqRef.current !== req) return;
          setStatus('speaking');
          const session = createSpeechSession(
            () => {
              if (reqRef.current === req) reset();
            },
            (chars) => {
              if (reqRef.current === req) setSpokenChars(chars);
            },
          );
          sessionRef.current = session;
          session.push(fullText.slice(base));
          session.finish();

          // Barge-in: listen for the stop word while speaking, then mic off.
          // Strict threshold — the agent's own audio must not false-trigger it.
          void listenForWords(
            [getStopWord()],
            () => {
              if (reqRef.current === req) stop();
            },
            0.97,
          )
            .then((s) => {
              if (reqRef.current !== req) {
                s();
                return;
              }
              kwsStopRef.current = s;
            })
            .catch(() => {});
        } catch {
          if (reqRef.current === req) reset();
        }
      })();
    },
    [reset, stop],
  );

  const toggle = useCallback(
    (id: number, text: string) => {
      if (activeId === id) {
        stop();
        return;
      }
      startSpeaking(id, text, 0);
    },
    [activeId, stop, startSpeaking],
  );

  const speakFrom = useCallback(
    (id: number, text: string, fromParagraph: number) => {
      const infos = splitParagraphs(text);
      const idx = Math.max(0, Math.min(fromParagraph, infos.length - 1));
      startSpeaking(id, text, infos[idx]?.start ?? 0);
    },
    [startSpeaking],
  );

  return (
    <SpeechContext.Provider
      value={{
        activeId,
        status,
        progress,
        spokenChars,
        speakBase,
        supported,
        toggle,
        speakFrom,
        stop,
      }}
    >
      {children}
    </SpeechContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSpeech(): SpeechValue {
  const ctx = useContext(SpeechContext);
  if (!ctx) throw new Error('useSpeech must be used within SpeechProvider');
  return ctx;
}
