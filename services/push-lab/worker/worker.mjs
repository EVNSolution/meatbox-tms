import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { acquireWorkerLock } from './lock.mjs';
import { classifyProviderError, createSender, retryAfterMs, sendWithTimeout } from './sender.mjs';
import { WorkerStore } from './store.mjs';

function waitForDrain(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function clearPauseMarker(path) {
  await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

async function readPauseMarker(path) {
  try {
    const marker = JSON.parse(await readFile(path, 'utf8'));
    return { code: typeof marker.code === 'string' ? marker.code : 'invalid_pause_marker' };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { code: 'invalid_pause_marker' };
  }
}

async function writePauseMarker(path, code, timestamp) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ code, timestamp })}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function startWorker({
  db,
  dbPath = process.env.DB_PATH || './data/push-lab.sqlite',
  sender,
  pollMs = 500,
  owner = randomUUID(),
  now,
  senderTimeoutMs = 10_000,
  drainMs = 30_000,
  storeOptions = {},
  logger = console,
  clearPause = process.env.PUSH_LAB_CLEAR_PAUSE === '1',
} = {}) {
  const pausePath = process.env.WORKER_PAUSE_PATH || join(dirname(resolve(dbPath)), 'worker.pause');
  const lock = await acquireWorkerLock(dbPath);
  const store = new WorkerStore(db, { now, ...storeOptions });
  const lease = store.acquire(owner);
  if (!lease) {
    await lock.release();
    throw new Error('worker DB lease is held by another owner');
  }
  let startupPause = null;
  try {
    sender ||= await createSender();
    const marker = await readPauseMarker(pausePath);
    if (marker && clearPause) await clearPauseMarker(pausePath);
    else startupPause = marker;
  } catch (error) {
    store.release(lease);
    await lock.release();
    throw error;
  }

  let stopped = false;
  let paused = startupPause != null;
  let pauseReason = startupPause?.code || null;
  let timer;
  let heartbeatTimer;
  let heartbeatWork = Promise.resolve();
  let activeAttempt = null;
  let stopPromise;

  if (startupPause) logger.error('push-lab worker remains paused', { code: startupPause.code });

  const stopHeartbeat = () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const pauseWorker = async (code, reason = code) => {
    if (paused || stopped) return;
    paused = true;
    pauseReason = reason;
    stopHeartbeat();
    try {
      await writePauseMarker(pausePath, code, now ? now() : Date.now());
      logger.error('push-lab worker paused', { code });
    } catch {
      logger.error('push-lab worker pause marker write failed', { code });
    }
  };

  const heartbeat = async () => {
    if (stopped || paused) return;
    try {
      if (!store.heartbeat(lease)) await pauseWorker('worker_lease_lost');
    } catch {
      await pauseWorker('worker_lease_lost');
    }
  };

  if (!paused) {
    heartbeatTimer = setInterval(() => {
      heartbeatWork = heartbeatWork.then(heartbeat, heartbeat);
    }, Math.max(1, Math.floor(store.leaseMs / 3)));
    heartbeatTimer.unref?.();
  }

  const runOnce = async () => {
    if (stopped || paused || activeAttempt) return false;
    try {
      if (!store.heartbeat(lease)) {
        await pauseWorker('worker_lease_lost');
        return false;
      }
    } catch {
      await pauseWorker('worker_lease_lost');
      return false;
    }
    const item = store.claim(lease);
    if (!item) return false;
    item.owner = lease.owner;
    const attempt = { item, finalized: false, done: null };
    activeAttempt = attempt;
    attempt.done = (async () => {
      try {
        const ttlSeconds = Math.max(0, Math.floor((item.expires_at - (now ? now() : Date.now())) / 1000));
        const messageId = await sendWithTimeout(sender, {
          fid: item.selected_fid,
          deliveryId: item.delivery_id,
          notificationId: item.id,
          ttlSeconds,
        }, senderTimeoutMs);
        if (!attempt.finalized) {
          store.finish(item, { messageId });
          attempt.finalized = true;
        }
      } catch (error) {
        const errorClass = classifyProviderError(error);
        if (!attempt.finalized) {
          store.finish(item, { errorClass, retryAfterMs: retryAfterMs(error, now ? now() : Date.now()) });
          attempt.finalized = true;
        }
        if (errorClass === 'configuration') {
          await pauseWorker(error.code || 'configuration', error.message);
        }
        // A timed-out Admin call cannot be cancelled. Keep the attempt active
        // until it settles so no later provider call overlaps it.
        if (error?.settlement) await error.settlement;
      } finally {
        if (activeAttempt === attempt) activeAttempt = null;
      }
      return true;
    })();
    return attempt.done;
  };

  const loop = async () => {
    if (stopped) return;
    await runOnce();
    if (stopped) return;
    timer = setTimeout(loop, pollMs);
    timer.unref?.();
  };
  loop();

  return {
    owner,
    runOnce,
    get paused() { return paused; },
    get pauseReason() { return pauseReason; },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopped = true;
        clearTimeout(timer);
        stopHeartbeat();
        await heartbeatWork;
        const attempt = activeAttempt;
        if (attempt && !await waitForDrain(attempt.done, drainMs) && !attempt.finalized) {
          store.markUnknown(attempt.item);
          attempt.finalized = true;
        }
        store.release(lease);
        await lock.release();
      })();
      return stopPromise;
    },
  };
}
