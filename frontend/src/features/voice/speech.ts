import { api } from '@/api/collaborator';
import { getCapabilities } from '@/lib/capabilities';
import { getServerVoice, getTtsEngine } from '@/features/settings/uiPrefs';
import { SpeechQueue } from './speechQueue';
import { WebSpeechSession, webSpeechSupported } from './webSpeech';
import type { SpeechSession } from './speechUtils';

export type { SpeechSession } from './speechUtils';
export { webSpeechSupported } from './webSpeech';

/**
 * Create a speech session for the engine selected in Settings. `onFailed`
 * receives the [start, end) original-char range of any sentence that could
 * not be synthesized/spoken (so the UI can flag unread text).
 *
 * 'server' synthesizes via POST /api/tts (sentence-pipelined, same queue as
 * Piper); if the backend stops advertising tts_stream (reconfigured, or a
 * stale pref against an older server) it silently falls back to Piper rather
 * than 503ing every sentence.
 */
export function createSpeechSession(
  onIdle?: () => void,
  onProgress?: (chars: number) => void,
  onFailed?: (start: number, end: number) => void,
): SpeechSession {
  const engine = getTtsEngine();
  if (engine === 'browser' && webSpeechSupported()) {
    return new WebSpeechSession(onIdle, onProgress, onFailed);
  }
  if (engine === 'server' && getCapabilities().ttsStream) {
    const voice = getServerVoice() || undefined;
    return new SpeechQueue(onIdle, onProgress, onFailed, (text) =>
      api.synthesizeSpeech(text, voice),
    );
  }
  return new SpeechQueue(onIdle, onProgress, onFailed);
}
