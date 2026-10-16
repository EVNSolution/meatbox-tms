import type { EventReply } from '../api/driverContracts';
import { ApiError } from '../api/types';

// The device-side queue of stop events (docs/integration-contract.md section 1): a stop is closed on the phone at
// once, and the queue sends it later, in the order it was saved, photos first. This file is the state machine only;
// storage, files and the network come in through [OutboxPorts], so every rule here is tested without a device.

/** Waits between tries: 5 s, 15 s, 45 s, 2 min, then 5 min for as long as it takes. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

export type OutboxState = 'pending' | 'uploading' | 'sent' | 'rejected';

export type OutboxPhoto = { localPath: string; photoId: string | null };

export type OutboxItem = {
  eventId: string;
  occurredAt: string;
  date: string;
  vehicleId: string;
  type: string;
  stopId: string;
  /** Without `photoIds`; they are added from the uploaded photos when the event is sent. */
  payload: Record<string, unknown>;
  photos: OutboxPhoto[];
  attempts: number;
  /** Epoch ms before which the item is not tried again. */
  nextAt: number;
  state: OutboxState;
  /** The server may already have the event (an answer was lost), so look it up before sending again. */
  uncertain: boolean;
  /** Why a rejected item stopped: the problem code, or HTTP_status. */
  reason: string | null;
  reasonStatus: number | null;
  reply: EventReply | null;
};

export type NewOutboxItem = Pick<OutboxItem, 'eventId' | 'occurredAt' | 'date' | 'vehicleId' | 'type' | 'stopId' | 'payload'> & {
  photoPaths: string[];
};

export type OutboxPorts = {
  load(): Promise<OutboxItem[]>;
  save(items: readonly OutboxItem[]): Promise<void>;
  now(): number;
  photoReady(localPath: string): boolean;
  uploadPhoto(date: string, localPath: string): Promise<{ photoId: string }>;
  sendEvent(item: OutboxItem, payload: Record<string, unknown>): Promise<EventReply>;
  lookupEvent(date: string, eventId: string): Promise<EventReply | null>;
  removePhotos(item: OutboxItem): void;
};

export type StepResult =
  | { kind: 'idle' }
  | { kind: 'waiting'; nextAt: number }
  | { kind: 'blocked'; item: OutboxItem }
  | { kind: 'sent'; item: OutboxItem }
  | { kind: 'retry'; item: OutboxItem }
  | { kind: 'rejected'; item: OutboxItem };

type Failure = 'retry' | 'reject';

/** 409 and the 4xx answers that retrying cannot fix stop the item; network errors, 429 and 5xx wait and try again. */
export function classify(error: unknown): Failure {
  if (!(error instanceof ApiError)) return 'retry';
  const { status } = error;
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'reject';
}

export function retryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
}

export class Outbox {
  private items: OutboxItem[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ports: OutboxPorts,
    private readonly onChange: (items: readonly OutboxItem[]) => void = () => undefined,
  ) {}

  /** Loads the saved queue. An item that was mid-send when the app died may have reached the server. */
  async init(): Promise<void> {
    this.items = (await this.ports.load()).map((item) =>
      item.state === 'uploading' ? { ...item, state: 'pending', uncertain: true } : item);
    this.changed();
  }

  list(): readonly OutboxItem[] {
    return this.items;
  }

  /** Items still owed to the server (not yet sent): the badge number. */
  waitingCount(): number {
    return this.items.filter((item) => item.state !== 'sent').length;
  }

  rejectedCount(): number {
    return this.items.filter((item) => item.state === 'rejected').length;
  }

  photoCount(): number {
    return this.items.filter((item) => item.state !== 'sent').reduce((sum, item) => sum + item.photos.length, 0);
  }

  enqueue(input: NewOutboxItem): Promise<void> {
    return this.serial(async () => {
      if (this.items.some((item) => item.eventId === input.eventId)) return;
      const { photoPaths, ...rest } = input;
      this.items = [...this.items, {
        ...rest,
        photos: photoPaths.map((localPath) => ({ localPath, photoId: null })),
        attempts: 0, nextAt: 0, state: 'pending', uncertain: false, reason: null, reasonStatus: null, reply: null,
      }];
      await this.persist();
    });
  }

  /** Tries the first unsent item once. Strictly one at a time, in saved order. */
  step(): Promise<StepResult> {
    return this.serial(() => this.stepNow());
  }

  /** Runs steps until the queue is idle, waiting for a retry or blocked on a rejected item. */
  async drain(): Promise<StepResult> {
    for (;;) {
      const result = await this.step();
      if (result.kind === 'sent') continue;
      if (result.kind === 'retry') return { kind: 'waiting', nextAt: result.item.nextAt };
      if (result.kind === 'rejected') return { kind: 'blocked', item: result.item };
      return result;
    }
  }

  /** Lets a waiting or rejected item try again now. */
  retryNow(eventId: string): Promise<void> {
    return this.serial(async () => {
      this.items = this.items.map((item) => item.eventId === eventId && item.state !== 'sent'
        ? { ...item, state: 'pending', nextAt: 0, reason: null, reasonStatus: null }
        : item);
      await this.persist();
    });
  }

  /** Drops an item and its photos. Its stop is no longer shown as closed on the phone. */
  discard(eventId: string): Promise<void> {
    return this.serial(async () => {
      const found = this.items.find((item) => item.eventId === eventId);
      if (!found) return;
      this.ports.removePhotos(found);
      this.items = this.items.filter((item) => item !== found);
      await this.persist();
    });
  }

  /** Forgets items the server has confirmed once the screen shows the server's state. */
  pruneSent(): Promise<void> {
    return this.serial(async () => {
      const kept = this.items.filter((item) => item.state !== 'sent');
      if (kept.length === this.items.length) return;
      this.items = kept;
      await this.persist();
    });
  }

  private async stepNow(): Promise<StepResult> {
    const head = this.items.find((item) => item.state !== 'sent');
    if (!head) return { kind: 'idle' };
    if (head.state === 'rejected') return { kind: 'blocked', item: head };
    if (head.nextAt > this.ports.now()) return { kind: 'waiting', nextAt: head.nextAt };
    await this.update(head.eventId, { state: 'uploading' });
    try {
      await this.uploadPhotos(head.eventId);
      const current = this.find(head.eventId);
      if (current.uncertain) {
        const found = await this.ports.lookupEvent(current.date, current.eventId);
        if (found) return await this.finish(head.eventId, found);
      }
      const ready = this.find(head.eventId);
      const photoIds = ready.photos.map((photo) => photo.photoId as string);
      const payload = photoIds.length > 0 ? { ...ready.payload, photoIds } : ready.payload;
      return await this.finish(head.eventId, await this.ports.sendEvent(ready, payload));
    } catch (error) {
      return this.fail(head.eventId, error);
    }
  }

  private async uploadPhotos(eventId: string): Promise<void> {
    for (const [index, photo] of this.find(eventId).photos.entries()) {
      if (photo.photoId) continue;
      if (!this.ports.photoReady(photo.localPath)) throw new ApiError(400, 'PHOTO_FILE_MISSING');
      const { photoId } = await this.ports.uploadPhoto(this.find(eventId).date, photo.localPath);
      await this.update(eventId, {
        photos: this.find(eventId).photos.map((entry, at) => (at === index ? { ...entry, photoId } : entry)),
      });
    }
  }

  private async finish(eventId: string, reply: EventReply): Promise<StepResult> {
    this.ports.removePhotos(this.find(eventId));
    await this.update(eventId, { state: 'sent', reply, uncertain: false, reason: null, reasonStatus: null });
    return { kind: 'sent', item: this.find(eventId) };
  }

  private async fail(eventId: string, error: unknown): Promise<StepResult> {
    const sending = this.find(eventId);
    if (classify(error) === 'retry') {
      const attempts = sending.attempts + 1;
      // Any failure after the send started may hide an event the server already took: look it up next time.
      await this.update(eventId, { state: 'pending', attempts, nextAt: this.ports.now() + retryDelay(attempts), uncertain: sending.uncertain || this.allUploaded(sending) });
      return { kind: 'retry', item: this.find(eventId) };
    }
    const status = error instanceof ApiError ? error.status : null;
    const reason = error instanceof ApiError ? error.code : 'UNKNOWN';
    await this.update(eventId, { state: 'rejected', reason, reasonStatus: status });
    return { kind: 'rejected', item: this.find(eventId) };
  }

  private allUploaded(item: OutboxItem): boolean {
    return item.photos.every((photo) => photo.photoId !== null);
  }

  private find(eventId: string): OutboxItem {
    const found = this.items.find((item) => item.eventId === eventId);
    if (!found) throw new Error(`outbox item ${eventId} is gone`);
    return found;
  }

  private async update(eventId: string, patch: Partial<OutboxItem>): Promise<void> {
    this.items = this.items.map((item) => (item.eventId === eventId ? { ...item, ...patch } : item));
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.ports.save(this.items);
    this.changed();
  }

  private changed(): void {
    this.onChange(this.items);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
