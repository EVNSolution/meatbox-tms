import { openDatabase } from './db.mjs';
import { isIP } from 'node:net';
import { createPushLabServer } from './http.mjs';
import { PushLabService } from './service.mjs';
import { drainHttpServer } from './shutdown.mjs';

export function startWeb({ db = openDatabase(), port = Number(process.env.PORT || 3000), host = process.env.PUSH_LAB_BIND_HOST ?? '0.0.0.0' } = {}) {
  if (!isIP(host)) throw new Error('PUSH_LAB_BIND_HOST must be a literal IP address');
  const service = new PushLabService(db);
  const server = createPushLabServer({ db, service });
  server.listen(port, host);
  return { db, service, server };
}

export async function shutdownWeb({ db, server }, options) {
  try {
    await drainHttpServer(server, options);
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = startWeb();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await shutdownWeb(app);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
