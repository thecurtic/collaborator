/// <reference lib="webworker" />
// On-device speech-to-text with Transformers.js v3 (whisper-tiny). Runs entirely
// in this worker — no audio leaves the device. Tries WebGPU, falls back to WASM.
import { pipeline, env } from '@huggingface/transformers';

// Remote model only (onnx-community/whisper-tiny); the library caches weights in
// the browser Cache Storage after the first download.
env.allowLocalModels = false;

const MODEL = 'onnx-community/whisper-tiny';
const PARTIAL_INTERVAL_MS = 1500;

// The library's typed pipeline result is a huge union; we only need a callable
// that returns { text }, so keep a narrow local type.
type AsrResult = { text?: string } | Array<{ text?: string }>;
type Asr = (
  audio: Float32Array,
  opts?: Record<string, unknown>,
) => Promise<AsrResult>;

let asr: Asr | null = null;
let chunks: Float32Array[] = [];
let total = 0;
let busy = false;
let lastPartialAt = 0;

function reset() {
  chunks = [];
  total = 0;
  lastPartialAt = 0;
}

function concat(): Float32Array {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// The last `maxSamples` of audio (for a fast live partial).
function concatTail(maxSamples: number): Float32Array {
  if (total <= maxSamples) return concat();
  const out = new Float32Array(maxSamples);
  let need = maxSamples;
  let o = maxSamples;
  for (let i = chunks.length - 1; i >= 0 && need > 0; i--) {
    const c = chunks[i];
    const take = Math.min(need, c.length);
    o -= take;
    out.set(c.subarray(c.length - take), o);
    need -= take;
  }
  return out;
}

const TAIL_S = 30; // Whisper's window; partials only look at the last 30s.

// Whisper only transcribes the first 30s unless chunked. For the FINAL we enable
// long-form chunking so an utterance of any length is fully transcribed; partials
// stay fast by only transcribing the recent tail.
async function transcribe(full: boolean): Promise<string> {
  if (!asr || total === 0) return '';
  const audio = full ? concat() : concatTail(TAIL_S * 16000);
  const opts = full
    ? {
        language: 'en',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      }
    : { language: 'en', task: 'transcribe' };
  const res = await asr(audio, opts);
  const text = Array.isArray(res) ? res[0]?.text : res.text;
  return (text ?? '').trim();
}

async function load(device: 'webgpu' | 'wasm'): Promise<Asr> {
  return (await pipeline('automatic-speech-recognition', MODEL, {
    device,
  })) as unknown as Asr;
}

async function init() {
  try {
    asr = await load('webgpu');
    postMessage({ type: 'ready', device: 'webgpu' });
  } catch {
    try {
      asr = await load('wasm');
      postMessage({ type: 'ready', device: 'wasm' });
    } catch (e) {
      postMessage({
        type: 'error',
        detail: e instanceof Error ? e.message : 'model load failed',
      });
    }
  }
}

async function maybePartial() {
  if (busy) return;
  const now = Date.now();
  if (now - lastPartialAt < PARTIAL_INTERVAL_MS) return;
  lastPartialAt = now;
  busy = true;
  try {
    postMessage({ type: 'partial', text: await transcribe(false) });
  } catch {
    /* ignore — try again next interval */
  } finally {
    busy = false;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: string; buf?: ArrayBuffer };
  if (m.type === 'init') {
    await init();
  } else if (m.type === 'audio' && m.buf) {
    const pcm = new Int16Array(m.buf);
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
    chunks.push(f);
    total += f.length;
    void maybePartial();
  } else if (m.type === 'end') {
    while (busy) await new Promise((r) => setTimeout(r, 40));
    let text = '';
    try {
      text = await transcribe(true); // full, long-form chunked
    } catch {
      /* ignore */
    }
    postMessage({ type: 'final', text });
    reset();
  } else if (m.type === 'reset') {
    reset();
  }
};
