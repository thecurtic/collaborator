import { getTtsEngine } from '@/features/settings/uiPrefs';
import { SpeechQueue } from './speechQueue';
import { WebSpeechSession, webSpeechSupported } from './webSpeech';
import type { SpeechSession } from './speechUtils';

export type { SpeechSession } from './speechUtils';
export { webSpeechSupported } from './webSpeech';

/** Create a speech session for the engine selected in Settings. */
export function createSpeechSession(onIdle?: () => void): SpeechSession {
  if (getTtsEngine() === 'browser' && webSpeechSupported()) {
    return new WebSpeechSession(onIdle);
  }
  return new SpeechQueue(onIdle);
}
