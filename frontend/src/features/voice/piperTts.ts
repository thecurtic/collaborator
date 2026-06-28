import {
  download,
  predict,
  stored,
  type VoiceId,
} from '@diffusionstudio/vits-web';
import { getPiperVoice } from '@/features/settings/uiPrefs';

/**
 * Client-side TTS via Piper (vits-web). Runs the ONNX model in a worker and
 * caches the voice in OPFS after the first download (~tens of MB). Fully local —
 * no audio leaves the device. The active voice comes from UI prefs.
 */
function voiceId(): VoiceId {
  return getPiperVoice() as VoiceId;
}

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

export async function isVoiceStored(): Promise<boolean> {
  try {
    return (await stored()).includes(voiceId());
  } catch {
    return false;
  }
}

/** Prefetch the active voice model, reporting 0..1 progress. */
export function downloadVoice(
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return download(voiceId(), (p) => {
    if (p.total) onProgress?.(p.loaded / p.total);
  });
}

/** Synthesize text to a WAV blob (downloads the voice first if needed). */
export function synthesize(text: string): Promise<Blob> {
  return predict({ text, voiceId: voiceId() });
}

function cleanupAudio() {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  currentAudio = null;
}

/** Play a blob, stopping any current playback first. */
export function playBlob(blob: Blob, onEnded?: () => void): void {
  stopPlayback();
  currentUrl = URL.createObjectURL(blob);
  const audio = new Audio(currentUrl);
  audio.playbackRate = 1.12;
  currentAudio = audio;
  const finish = () => {
    cleanupAudio();
    onEnded?.();
  };
  audio.addEventListener('ended', finish);
  audio.addEventListener('error', finish);
  void audio.play().catch(finish);
}

export function stopPlayback(): void {
  currentAudio?.pause();
  cleanupAudio();
}
