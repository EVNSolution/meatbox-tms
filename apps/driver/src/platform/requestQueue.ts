// Poll ticks share an unfinished read. An explicit refresh can queue one newer read.
export class RequestGate {
  private readonly pending = new Map<string, Promise<void>>();

  run(key: string, read: () => Promise<void>, afterCurrent = false): Promise<void> {
    const current = this.pending.get(key);
    if (current) {
      return afterCurrent ? current.then(() => this.run(key, read), () => this.run(key, read)) : current;
    }
    const result = Promise.resolve().then(read).finally(() => {
      if (this.pending.get(key) === result) this.pending.delete(key);
    });
    this.pending.set(key, result);
    return result;
  }
}

// This queue survives React remounts when owned by a platform module.
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
