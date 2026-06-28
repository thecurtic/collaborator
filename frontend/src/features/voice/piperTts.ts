import {
  download,
  predict,
  stored,
  type VoiceId,
} from '@diffusionstudio/vits-web';

/**
 * Client-side TTS via Piper (vits-web). Runs the ONNX model in a worker and
 * caches the voice in OPFS after the first download (~tens of MB). Fully local —
 * no audio leaves the device.
 */
export const VOICE_ID: VoiceId = 'en_US-amy-medium';

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

export async function isVoiceStored(): Promise<boolean> {
  try {
    return (await stored()).includes(VOICE_ID);
  } catch {
    return false;
  }
}

/** Prefetch the voice model, reporting 0..1 progress. */
export function downloadVoice(
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return download(VOICE_ID, (p) => {
    if (p.total) onProgress?.(p.loaded / p.total);
  });
}

/** Synthesize text to a WAV blob (downloads the voice first if needed). */
export function synthesize(text: string): Promise<Blob> {
  return predict({ text, voiceId: VOICE_ID });
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
  currentAudio = audio;
  audio.addEventListener('ended', () => {
    cleanupAudio();
    onEnded?.();
  });
  void audio.play();
}

export function stopPlayback(): void {
  currentAudio?.pause();
  cleanupAudio();
}
