/**
 * lib semaphore — concurrency control (slot-semaphore).
 */
import { TimeoutError } from "./errors.js";

export class SlotSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  private readonly maxSlots: number;

  constructor(max: number) {
    if (max < 1) {
      throw new Error(`SlotSemaphore: max must be >= 1, got ${max}`);
    }
    this.maxSlots = max;
    this.available = max;
  }

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }

    return new Promise<() => void>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            const idx = this.waiters.indexOf(continueWith);
            if (idx >= 0) this.waiters.splice(idx, 1);
            reject(new TimeoutError(timeoutMs, "semaphore.acquire"));
          }, timeoutMs)
        : null;

      const continueWith = (): void => {
        if (timer) clearTimeout(timer);
        this.available -= 1;
        resolve(() => this.release());
      };
      this.waiters.push(continueWith);
    });
  }

  private release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) {
      this.available -= 1;
      setImmediate(next);
    }
  }

  get freeSlots(): number {
    return this.available;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  get max(): number {
    return this.maxSlots;
  }
}
