import { describe, expect, it } from 'vitest';
import { UploadQueue } from './uploadQueue';

/** An upload the test finishes by hand. */
function controllable() {
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void; progress: (p: number) => void }>();
  const discarded: string[] = [];
  const sent: string[] = [];
  const q = new UploadQueue<string, string>({
    upload: (_file, name, _signal, onProgress) =>
      new Promise((resolve, reject) => pending.set(name, { resolve, reject, progress: onProgress })),
    discard: (r) => discarded.push(r),
    send: (args) => sent.push(args),
  });
  return { q, pending, discarded, sent };
}

const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('UploadQueue', () => {
  it('sends at once when nothing is uploading', () => {
    const { q, sent } = controllable();
    q.queue('hello');
    expect(sent).toEqual(['hello']);
    expect(q.snapshot().queued).toBe(false);
  });

  it('queues a send until every upload is ready', async () => {
    const { q, pending, sent } = controllable();
    q.add([file('a.jpg'), file('b.jpg')]);
    q.queue('go');
    expect(sent).toEqual([]);
    expect(q.snapshot()).toMatchObject({ uploading: true, queued: true, held: false });

    pending.get('a.jpg')!.progress(0.5);
    expect(q.snapshot().items[0].progress).toBe(0.5);
    pending.get('a.jpg')!.resolve('id-a');
    await tick();
    expect(sent).toEqual([]);                    // b is still on its way
    pending.get('b.jpg')!.resolve('id-b');
    await tick();
    expect(sent).toEqual(['go']);
    expect(q.snapshot().queued).toBe(false);
    expect(q.snapshot().items.map((f) => f.result)).toEqual(['id-a', 'id-b']);
  });

  it('holds the send on a failed upload until it is retried', async () => {
    const { q, pending, sent } = controllable();
    q.add([file('a.jpg')]);
    q.queue('go');
    pending.get('a.jpg')!.reject(new Error('network down'));
    await tick();
    expect(q.snapshot()).toMatchObject({ failed: true, held: true, queued: true });
    expect(q.snapshot().items[0]).toMatchObject({ status: 'error', error: 'network down' });
    expect(sent).toEqual([]);

    q.retry(q.snapshot().items[0].key);
    expect(q.snapshot().items[0].status).toBe('uploading');
    pending.get('a.jpg')!.resolve('id-a');
    await tick();
    expect(sent).toEqual(['go']);
  });

  it('removing the failed file releases the held send', async () => {
    const { q, pending, sent } = controllable();
    q.add([file('a.jpg'), file('b.jpg')]);
    q.queue('go');
    pending.get('a.jpg')!.resolve('id-a');
    pending.get('b.jpg')!.reject(new Error('too big'));
    await tick();
    expect(sent).toEqual([]);
    q.remove(q.snapshot().items[1].key);
    expect(sent).toEqual(['go']);
  });

  it('waits for a block (a reply streaming) as well', async () => {
    const { q, sent } = controllable();
    q.setBlocked(true);
    q.queue('go');
    expect(sent).toEqual([]);
    q.setBlocked(false);
    expect(sent).toEqual(['go']);
  });

  it('cancelling drops the queued send, and removing discards the upload', async () => {
    const { q, pending, sent, discarded } = controllable();
    q.add([file('a.jpg')]);
    q.queue('go');
    q.cancel();
    pending.get('a.jpg')!.resolve('id-a');
    await tick();
    expect(sent).toEqual([]);
    q.remove(q.snapshot().items[0].key);
    expect(discarded).toEqual(['id-a']);
  });

  it('an upload finishing after its file was removed is discarded', async () => {
    const { q, pending, discarded } = controllable();
    q.add([file('a.jpg')]);
    q.remove(q.snapshot().items[0].key);
    pending.get('a.jpg')!.resolve('late');
    await tick();
    expect(discarded).toEqual(['late']);
    expect(q.snapshot().items).toEqual([]);
  });

  it('take hands the files over; restore puts them back', () => {
    const { q } = controllable();
    q.add([file('a.jpg')]);
    const taken = q.take();
    expect(q.snapshot().items).toEqual([]);
    q.restore(taken);
    expect(q.snapshot().items).toHaveLength(1);
  });

  it('respects max', () => {
    const q = new UploadQueue<string, string>(
      { upload: () => new Promise(() => {}), send: () => {} }, 2);
    expect(q.add([file('a'), file('b'), file('c')])).toHaveLength(2);
    expect(q.add([file('d')])).toEqual([]);
  });
});
