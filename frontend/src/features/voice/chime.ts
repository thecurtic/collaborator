// Short Web Audio chimes to signal the mic turning on/off (like most voice apps).
// No assets — synthesized with an oscillator. Reuses one AudioContext.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      ctx = new Ctx();
    }
    void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function beep(freq: number, startOffset: number, duration: number): void {
  const audio = getCtx();
  if (!audio) return;
  const t0 = audio.currentTime + startOffset;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.06, t0 + 0.015);
  gain.gain.linearRampToValueAtTime(0, t0 + duration);
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** Rising two-tone: mic now listening. */
export function chimeListenStart(): void {
  beep(660, 0, 0.12);
  beep(990, 0.1, 0.14);
}

/** Falling two-tone: mic stopped listening. */
export function chimeListenStop(): void {
  beep(880, 0, 0.12);
  beep(523, 0.1, 0.14);
}
