import { afterEach, describe, expect, it, vi } from 'vitest';
import { goBack, installBack, registerModalBack } from './back';

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe('back stack', () => {
  it('has nowhere to go when nothing is registered', () => {
    expect(goBack()).toBe(false);
  });

  it('runs the most recently opened modal first', () => {
    const calls: string[] = [];
    const offA = registerModalBack(() => calls.push('a'));
    const offB = registerModalBack(() => calls.push('b'));
    expect(goBack()).toBe(true);
    offB();
    expect(goBack()).toBe(true);
    offA();
    expect(calls).toEqual(['b', 'a']);
    expect(goBack()).toBe(false);
  });
});

describe('history guard', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.unstubAllGlobals();
  });

  function fakeWindow() {
    const listeners: ((e: { state: unknown }) => void)[] = [];
    const history = {
      state: null as unknown,
      pushState: vi.fn((state: unknown) => {
        history.state = state;
      }),
      back: vi.fn(),
    };
    const win = {
      history,
      addEventListener: (_: string, fn: (e: { state: unknown }) => void) => listeners.push(fn),
      removeEventListener: () => {},
    };
    vi.stubGlobal('window', win);
    const pop = (state: unknown = null) => {
      history.state = state;
      listeners.forEach((fn) => fn({ state }));
    };
    return { history, pop };
  }

  it('keeps one guard entry while there is somewhere to go back to', async () => {
    const { history, pop } = fakeWindow();
    uninstall = installBack();
    const handler = vi.fn();
    const off = registerModalBack(handler);
    await flush();
    expect(history.pushState).toHaveBeenCalledTimes(1);

    // The back gesture pops the guard: the handler runs and, while the
    // entry is still registered, a fresh guard goes back on.
    pop(null);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(history.pushState).toHaveBeenCalledTimes(2);

    // Closed another way: the guard is unwound, and that pop runs nothing.
    off();
    await flush();
    expect(history.back).toHaveBeenCalledTimes(1);
    pop(null);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(history.pushState).toHaveBeenCalledTimes(2);
  });
});
