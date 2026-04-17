import { vi } from 'vitest';

/**
 * sendOrEdit mock whose resolution is controlled manually. Returns
 * `fn` to pass into `createStreamEditLoop`, `calls` to inspect the
 * argument sequence, and `resolve()` to finish the outstanding call.
 */
export function makeSendOrEdit() {
  const calls: string[] = [];
  let resolve: () => void = () => {};
  const fn = vi.fn(async (text: string) => {
    calls.push(text);
    await new Promise<void>((r) => {
      resolve = r;
    });
  });
  return {
    fn,
    calls,
    resolve: () => resolve(),
  };
}

/**
 * sendOrEdit mock that resolves synchronously. Use when the test only
 * cares about what was passed, not about awaiting outstanding I/O.
 */
export function makeImmediateSendOrEdit() {
  const calls: string[] = [];
  const fn = vi.fn(async (text: string) => {
    calls.push(text);
  });
  return { fn, calls };
}
