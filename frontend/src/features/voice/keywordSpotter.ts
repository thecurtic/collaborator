import type { SpeechCommandRecognizer } from '@tensorflow-models/speech-commands';

/**
 * On-device keyword spotting via TF.js speech-commands. Fully local (no audio
 * leaves the device), real-time (~1s). Fixed vocabulary — only the words the
 * model knows. TF.js + the model are dynamically imported so they're a lazy
 * chunk, loaded the first time voice is used.
 */

// Command-relevant words from the default 18w BROWSER_FFT model.
export const KEYWORD_OPTIONS = [
  'go',
  'stop',
  'yes',
  'no',
  'up',
  'down',
  'left',
  'right',
  'on',
  'off',
] as const;

let recognizerPromise: Promise<SpeechCommandRecognizer> | null = null;

async function getRecognizer(): Promise<SpeechCommandRecognizer> {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      const [speechCommands] = await Promise.all([
        import('@tensorflow-models/speech-commands'),
        import('@tensorflow/tfjs'),
      ]);
      const recognizer = speechCommands.create('BROWSER_FFT');
      await recognizer.ensureModelLoaded();
      return recognizer;
    })();
  }
  return recognizerPromise;
}

/** Pre-load the model so the first real use isn't delayed. */
export async function warmUpKeywordSpotter(): Promise<void> {
  await getRecognizer();
}

/**
 * Listen for any of `words` (case-insensitive). Calls `onMatch` with the word
 * when it's heard above `threshold`. Returns a stop function. Only one listener
 * can be active at a time — starting a new one stops the previous.
 */
export async function listenForWords(
  words: string[],
  onMatch: (word: string) => void,
  threshold = 0.8,
): Promise<() => void> {
  const recognizer = await getRecognizer();
  if (recognizer.isListening()) await recognizer.stopListening();

  const labels = recognizer.wordLabels();
  const targets = new Set(words.map((w) => w.toLowerCase()));

  await recognizer.listen(
    (result) => {
      const scores = result.scores as Float32Array;
      let maxI = 0;
      for (let i = 1; i < scores.length; i++) {
        if (scores[i] > scores[maxI]) maxI = i;
      }
      const word = labels[maxI]?.toLowerCase();
      if (word && scores[maxI] >= threshold && targets.has(word)) {
        onMatch(word);
      }
      return Promise.resolve();
    },
    {
      probabilityThreshold: threshold,
      overlapFactor: 0.5,
      includeSpectrogram: false,
      invokeCallbackOnNoiseAndUnknown: false,
    },
  );

  return () => {
    if (recognizer.isListening()) void recognizer.stopListening();
  };
}
