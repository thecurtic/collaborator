import { getTtsEngine } from '@/features/settings/uiPrefs';
import { SpeechQueue } from './speechQueue';
import { WebSpeechSession, webSpeechSupported } from './webSpeech';
import type { SpeechSession } from './speechUtils';

export type { SpeechSession } from './speechUtils';
export { webSpeechSupported } from './webSpeech';

/**
 * Create a speech session for the engine selected in Settings. `onFailed`
 * receives the [start, end) original-char range of any sentence that could
 * not be synthesized/spoken (so the UI can flag unread text).
 */
export function createSpeechSession(
  onIdle?: () => void,
  onProgress?: (chars: number) => void,
  onFailed?: (start: number, end: number) => void,
): SpeechSession {
  if (getTtsEngine() === 'browser' && webSpeechSupported()) {
    return new WebSpeechSession(onIdle, onProgress, onFailed);
  }
  return new SpeechQueue(onIdle, onProgress, onFailed);
}
