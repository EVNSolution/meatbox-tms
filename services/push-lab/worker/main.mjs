import { openDatabase } from '../server/db.mjs';
import { startWorker } from './worker.mjs';

const db = openDatabase();
const worker = await startWorker({ db });
const shutdown = async () => {
  await worker.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
