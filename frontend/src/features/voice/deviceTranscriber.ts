// On-device transcription that mirrors TranscriptionStream's interface, so call
// mode can swap between server (WebSocket) and device (Web Worker) freely.
// Audio never leaves the device.
//
// The worker (and the loaded Whisper model) is a module-level singleton kept
// resident across turns — re-creating it per turn reloaded the model each time,
// which stalled the call between turns and starved the keyword spotter.

interface WorkerMsg {
  type: string;
  text?: string;
  detail?: string;
}

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
let activeInstance: DeviceTranscriber | null = null;

function ensureWorker(): { worker: Worker; ready: Promise<void> } {
  if (worker && readyPromise) return { worker, ready: readyPromise };

  const w = new Worker(new URL('./whisperWorker.ts', import.meta.url), {
    type: 'module',
  });

  readyPromise = new Promise<void>((resolve, reject) => {
    const onInit = (e: MessageEvent) => {
      const m = e.data as WorkerMsg;
      if (m.type === 'ready') {
        w.removeEventListener('message', onInit);
        resolve();
      } else if (m.type === 'error') {
        w.removeEventListener('message', onInit);
        reject(new Error(m.detail ?? 'on-device model failed'));
      }
    };
    w.addEventListener('message', onInit);
    w.addEventListener('error', () => reject(new Error('worker failed')), {
      once: true,
    });
  });

  // If init fails (offline, WebGPU/WASM hiccup), drop the singleton so the
  // next attempt rebuilds the worker instead of reusing a dead one forever.
  readyPromise.catch(() => {
    if (worker === w) {
      w.terminate();
      worker = null;
      readyPromise = null;
    }
  });

  // Route partial/final/error to whichever transcriber is currently active.
  w.addEventListener('message', (e: MessageEvent) =>
    activeInstance?.handle(e.data as WorkerMsg),
  );
  w.postMessage({ type: 'init' });

  worker = w;
  return { worker: w, ready: readyPromise };
}

export class DeviceTranscriber {
  private worker: Worker;
  private readyP: Promise<void>;
  private finalPromise: Promise<string>;
  private resolveFinal!: (t: string) => void;
  private settled = false;

  constructor(private onPartial: (text: string) => void) {
    const { worker: w, ready } = ensureWorker();
    this.worker = w;
    this.readyP = ready;
    activeInstance = this;
    this.finalPromise = new Promise((resolve) => {
      this.resolveFinal = (t: string) => {
        if (!this.settled) {
          this.settled = true;
          resolve(t);
        }
      };
    });
    w.postMessage({ type: 'reset' }); // fresh utterance buffer
  }

  handle(m: WorkerMsg): void {
    if (m.type === 'partial') this.onPartial(m.text ?? '');
    else if (m.type === 'final') this.resolveFinal(m.text ?? '');
    else if (m.type === 'error') this.resolveFinal('');
  }

  ready(): Promise<void> {
    return this.readyP;
  }

  sendPcm(buf: ArrayBuffer): void {
    this.worker.postMessage({ type: 'audio', buf }, [buf]);
  }

  end(): Promise<string> {
    this.worker.postMessage({ type: 'end' });
    return this.finalPromise;
  }

  close(): void {
    if (activeInstance === this) activeInstance = null;
    this.resolveFinal(''); // unblock any pending end()
    // Worker is intentionally kept alive (model stays resident for next turn).
  }
}

