import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  downloadVoice,
  isVoiceStored,
  playBlob,
  stopPlayback,
  synthesize,
} from './piperTts';

export type SpeechStatus = 'idle' | 'preparing' | 'synthesizing' | 'playing';

interface SpeechValue {
  /** Id of the turn currently being spoken/loaded, or null. */
  activeId: number | null;
  status: SpeechStatus;
  /** Voice-model download progress (0..1) while `status === 'preparing'`. */
  progress: number;
  supported: boolean;
  /** Speak the text for a turn id; clicking the active one stops it. */
  toggle: (id: number, text: string) => void;
  stop: () => void;
}

const SpeechContext = createContext<SpeechValue | null>(null);

const supported = typeof Worker !== 'undefined';

export function SpeechProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [status, setStatus] = useState<SpeechStatus>('idle');
  const [progress, setProgress] = useState(0);
  // Monotonic token so a newer request invalidates any in-flight older one.
  const reqRef = useRef(0);

  const reset = useCallback(() => {
    setActiveId(null);
    setStatus('idle');
    setProgress(0);
  }, []);

  const stop = useCallback(() => {
    reqRef.current++;
    stopPlayback();
    reset();
  }, [reset]);

  const toggle = useCallback(
    (id: number, text: string) => {
      if (activeId === id) {
        stop();
        return;
      }
      const req = ++reqRef.current;
      stopPlayback();
      setActiveId(id);
      setProgress(0);

      void (async () => {
        try {
          if (!(await isVoiceStored())) {
            if (reqRef.current !== req) return;
            setStatus('preparing');
            await downloadVoice((f) => {
              if (reqRef.current === req) setProgress(f);
            });
          }
          if (reqRef.current !== req) return;
          setStatus('synthesizing');
          const blob = await synthesize(text);
          if (reqRef.current !== req) return;
          setStatus('playing');
          playBlob(blob, () => {
            if (reqRef.current === req) reset();
          });
        } catch {
          if (reqRef.current === req) reset();
        }
      })();
    },
    [activeId, stop, reset],
  );

  return (
    <SpeechContext.Provider
      value={{ activeId, status, progress, supported, toggle, stop }}
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
