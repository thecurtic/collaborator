// Minimal browser shim for Node's `util.promisify`, which
// @tensorflow-models/speech-commands imports. Aliased via vite.config.ts.
export function promisify(
  fn: (...args: unknown[]) => void,
): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (err: unknown, value: unknown) => {
        if (err) reject(err);
        else resolve(value);
      });
    });
}

export default { promisify };
