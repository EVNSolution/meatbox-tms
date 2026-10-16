import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { NewOutboxItem, OutboxItem } from '../outbox/Outbox';
import { outbox, subscribeOutbox } from '../platform/outboxPorts';

type Handlers = {
  /** The server confirmed an event: reread its state. Resolves true when the screen now shows the server's state. */
  onConfirmed(): Promise<boolean>;
  /** An item stopped on a 409: the server state differs from the phone's, so reread it. */
  onConflict(): void;
  onSessionLost(): void;
};

/**
 * Runs the device queue while the app is open: on start, on a new item, when the app returns to the foreground
 * and when the next retry is due. Nothing is sent while the app is closed (no background task yet).
 */
export function useOutbox(handlers: Handlers) {
  const [items, setItems] = useState<readonly OutboxItem[]>(outbox.list());
  const [ready, setReady] = useState(false);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(handlers);
  const again = useRef<() => void>(() => undefined);
  useEffect(() => { latest.current = handlers; }, [handlers]);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    try {
      for (;;) {
        const result = await outbox.step();
        if (result.kind === 'sent') {
          if (await latest.current.onConfirmed()) await outbox.pruneSent();
          continue;
        }
        if (result.kind === 'retry' || result.kind === 'waiting') {
          const nextAt = result.kind === 'retry' ? result.item.nextAt : result.nextAt;
          timer.current = setTimeout(() => again.current(), Math.max(0, nextAt - Date.now()));
        } else if (result.kind === 'rejected' || result.kind === 'blocked') {
          const { reasonStatus } = result.item;
          if (result.kind === 'rejected' && reasonStatus === 401) latest.current.onSessionLost();
          if (result.kind === 'rejected' && reasonStatus === 409) latest.current.onConflict();
        }
        return;
      }
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => { again.current = () => { void run(); }; }, [run]);

  useEffect(() => {
    let live = true;
    const unsubscribe = subscribeOutbox((next) => { if (live) setItems(next); });
    void outbox.init().then(async () => {
      // A login that expired stopped these items; a fresh session means they can go.
      await Promise.all(outbox.list().filter((item) => item.reasonStatus === 401).map((item) => outbox.retryNow(item.eventId)));
      if (live) { setReady(true); void run(); }
    });
    const foreground = AppState.addEventListener('change', (state) => { if (state === 'active') void run(); });
    return () => {
      live = false; unsubscribe(); foreground.remove();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [run]);

  const enqueue = useCallback(async (item: NewOutboxItem) => { await outbox.enqueue(item); void run(); }, [run]);
  const retryNow = useCallback(async (eventId: string) => { await outbox.retryNow(eventId); void run(); }, [run]);
  const discard = useCallback(async (eventId: string) => { await outbox.discard(eventId); void run(); }, [run]);

  return {
    items,
    ready,
    enqueue,
    retryNow,
    discard,
    waiting: items.filter((item) => item.state !== 'sent').length,
    rejected: items.filter((item) => item.state === 'rejected').length,
    photos: items.filter((item) => item.state !== 'sent').reduce((sum, item) => sum + item.photos.length, 0),
  };
}
