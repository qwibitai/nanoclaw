/**
 * Idle timer whose clock resets whenever activity is detected.
 * Keeps the container-runner callback free of raw setTimeout handles.
 */
export interface IdleTimer {
  reset(): void;
  clear(): void;
}

export function createIdleTimer(
  timeoutMs: number,
  onFire: () => void,
): IdleTimer {
  let handle = setTimeout(onFire, timeoutMs);
  return {
    reset() {
      clearTimeout(handle);
      handle = setTimeout(onFire, timeoutMs);
    },
    clear() {
      clearTimeout(handle);
    },
  };
}
