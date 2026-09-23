import { openDatabase } from './db.mjs';
import { createPushLabServer } from './http.mjs';
import { PushLabService } from './service.mjs';
import { startWorker } from '../worker/worker.mjs';
import { drainHttpServer } from './shutdown.mjs';

export async function startAll({ db = openDatabase(), port = Number(process.env.PORT || 3000) } = {}) {
  const service = new PushLabService(db);
  const server = createPushLabServer({ db, service });
  const worker = await startWorker({ db });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return { db, service, server, worker };
}

export async function shutdownAll({ db, server, worker }, options) {
  let drainError;
  try {
    await drainHttpServer(server, options);
  } catch (error) {
    drainError = error;
  }
  await worker.stop();
  db.close();
  if (drainError) throw drainError;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await startAll();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await shutdownAll(app);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
