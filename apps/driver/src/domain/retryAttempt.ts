/**
 * One attempt of an event, kept until the server has answered. The server accepts a resend of an event ID only when
 * the whole body is the same, so a resend after a lost response must reuse the ID *and* the stamped time and
 * location; a different request, or a finished one, makes a new attempt.
 */
export class RetryAttempt<T> {
  private current: { signature: string; value: T } | null = null;

  async get(signature: string, create: () => Promise<T> | T): Promise<T> {
    if (this.current?.signature !== signature) this.current = { signature, value: await create() };
    return this.current.value;
  }

  /** The request got a definite answer (accepted or refused), so the next one is new. */
  settle(): void {
    this.current = null;
  }
}
