import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { shutdownAll } from '../server/all.mjs';
import { drainHttpServer } from '../server/shutdown.mjs';

test('all mode drains HTTP before stopping the worker and closing the database', async () => {
  const order = [];
  let finishClose;
  const closing = new Promise((resolve) => { finishClose = resolve; });
  const app = {
    server: {
      beginDrain() { order.push('begin-drain'); },
      close(callback) {
        order.push('close-start');
        closing.then(() => { order.push('close-finished'); callback(); });
      },
    },
    worker: { async stop() { order.push('worker-stop'); } },
    db: { close() { order.push('db-close'); } },
  };
  const shutdown = shutdownAll(app);
  await Promise.resolve();
  assert.deepEqual(order, ['begin-drain', 'close-start']);
  finishClose();
  await shutdown;
  assert.deepEqual(order, ['begin-drain', 'close-start', 'close-finished', 'worker-stop', 'db-close']);
});

test('HTTP drain force-closes a stuck active request at the configured bound', async () => {
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const server = createServer(() => started());
  server.beginDrain = () => {};
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = get(`http://127.0.0.1:${server.address().port}/slow`);
  client.on('error', () => {});
  await requestStarted;
  const before = Date.now();
  const result = await drainHttpServer(server, { graceMs: 25 });
  assert.equal(result.forced, true);
  assert.ok(Date.now() - before < 500);
  client.destroy();
});
