// Captures mic audio as PCM16 mono 16 kHz via an AudioWorklet and hands raw
// Int16 ArrayBuffers to a callback (for streaming to the transcription socket).

const WORKLET = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / 16000; // resample context rate -> 16 kHz
    this._pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const out = [];
    for (; this._pos < ch.length; this._pos += this._ratio) {
      const i = Math.floor(this._pos);
      const frac = this._pos - i;
      const next = ch[i + 1] === undefined ? ch[i] : ch[i + 1];
      out.push(ch[i] + (next - ch[i]) * frac);
    }
    this._pos -= ch.length;
    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const v = Math.max(-1, Math.min(1, out[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    if (pcm.length) this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

export interface PcmStream {
  stop: () => void;
}

export async function startPcmStream(
  stream: MediaStream,
  onPcm: (buf: ArrayBuffer) => void,
): Promise<PcmStream> {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  let ctx: AudioContext;
  try {
    ctx = new Ctx({ sampleRate: 16000 });
  } catch {
    ctx = new Ctx();
  }
  await ctx.resume();
  const url = URL.createObjectURL(
    new Blob([WORKLET], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-processor');
  node.port.onmessage = (e) => onPcm(e.data as ArrayBuffer);
  // Connect through a muted gain so the worklet graph is pulled (some browsers
  // won't run a worklet that isn't connected to the destination).
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);

  return {
    stop: () => {
      try {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        /* ignore */
      }
      void ctx.close();
    },
  };
}
