// On-device transcription that mirrors TranscriptionStream's interface, so call
// mode can swap between server (WebSocket) and device (Web Worker) freely.
// Audio never leaves the device.

export class DeviceTranscriber {
  private worker: Worker;
  private opened: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private finalPromise: Promise<string>;
  private resolveFinal!: (t: string) => void;
  private settled = false;

  constructor(onPartial: (text: string) => void) {
    this.worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), {
      type: 'module',
    });

    this.opened = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.finalPromise = new Promise((resolve) => {
      this.resolveFinal = (t: string) => {
        if (!this.settled) {
          this.settled = true;
          resolve(t);
        }
      };
    });

    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; text?: string; detail?: string };
      if (m.type === 'ready') this.resolveReady();
      else if (m.type === 'partial') onPartial(m.text ?? '');
      else if (m.type === 'final') this.resolveFinal(m.text ?? '');
      else if (m.type === 'error') {
        this.rejectReady(new Error(m.detail ?? 'on-device model failed'));
        this.resolveFinal('');
      }
    };
    this.worker.onerror = () => {
      this.rejectReady(new Error('on-device transcription worker failed'));
      this.resolveFinal('');
    };

    this.worker.postMessage({ type: 'init' });
  }

  ready(): Promise<void> {
    return this.opened;
  }

  sendPcm(buf: ArrayBuffer): void {
    this.worker.postMessage({ type: 'audio', buf }, [buf]);
  }

  end(): Promise<string> {
    this.worker.postMessage({ type: 'end' });
    return this.finalPromise;
  }

  close(): void {
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}
