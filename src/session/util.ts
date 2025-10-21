export const deepFreeze = <T>(object: T): T => {
  Object.freeze(object);
  Object.getOwnPropertyNames(object).forEach((property) => {
    const value = (object as Record<string, unknown>)[property];
    if (
      value &&
      (typeof value === 'object' || typeof value === 'function') &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  });
  return object;
};

export const deepClone = <T>(object: T): T => JSON.parse(JSON.stringify(object));

export class AsyncMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export class IncrementingIdGenerator {
  private cursor: number;

  constructor(initialValue = 0) {
    this.cursor = initialValue;
  }

  next(prefix = 'id'): string {
    this.cursor += 1;
    return `${prefix}-${this.cursor}`;
  }
}
