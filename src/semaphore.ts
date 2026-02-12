/**
 * Simple counting semaphore for limiting concurrent async operations.
 */
export class Semaphore {
  private current = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** Try to acquire a slot. Returns true if acquired, false if at capacity. */
  tryAcquire(): boolean {
    if (this.current >= this.max) return false;
    this.current++;
    return true;
  }

  /** Release a slot. */
  release(): void {
    if (this.current > 0) this.current--;
  }

  /** Current number of active slots. */
  get active(): number {
    return this.current;
  }

  /** Maximum number of concurrent slots. */
  get capacity(): number {
    return this.max;
  }
}
