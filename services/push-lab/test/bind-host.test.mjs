import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { startWeb, shutdownWeb } from '../server/main.mjs';
import { startAll, shutdownAll } from '../server/all.mjs';

test('web mode uses the configured loopback bind and preserves the Docker default', async () => {
  const previous = process.env.PUSH_LAB_BIND_HOST;
  try {
    for (const [configured, expected] of [['127.0.0.1', '127.0.0.1'], [undefined, '0.0.0.0']]) {
      if (configured === undefined) delete process.env.PUSH_LAB_BIND_HOST;
      else process.env.PUSH_LAB_BIND_HOST = configured;
      const app = startWeb({ db: openDatabase(':memory:'), port: 0 });
      try {
        await once(app.server, 'listening');
        assert.equal(app.server.address().address, expected);
      } finally { await shutdownWeb(app); }
    }
  } finally {
    if (previous === undefined) delete process.env.PUSH_LAB_BIND_HOST;
    else process.env.PUSH_LAB_BIND_HOST = previous;
  }
});

test('all mode uses the configured loopback bind and preserves the Docker default', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'push-lab-bind-'));
  const previous = {
    bind: process.env.PUSH_LAB_BIND_HOST,
    dbPath: process.env.DB_PATH,
    sender: process.env.PUSH_LAB_SENDER_MODE,
  };
  process.env.DB_PATH = join(directory, 'push-lab.sqlite');
  process.env.PUSH_LAB_SENDER_MODE = 'mock';
  try {
    for (const [configured, expected] of [['127.0.0.1', '127.0.0.1'], [undefined, '0.0.0.0']]) {
      if (configured === undefined) delete process.env.PUSH_LAB_BIND_HOST;
      else process.env.PUSH_LAB_BIND_HOST = configured;
      const app = await startAll({ db: openDatabase(process.env.DB_PATH), port: 0 });
      try { assert.equal(app.server.address().address, expected); }
      finally { await shutdownAll(app); }
    }
  } finally {
    for (const [name, value] of [['PUSH_LAB_BIND_HOST', previous.bind], ['DB_PATH', previous.dbPath], ['PUSH_LAB_SENDER_MODE', previous.sender]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('empty and DNS bind hosts fail before either server starts', async () => {
  for (const start of [startWeb, startAll]) {
    for (const host of ['', 'localhost']) {
      const db = openDatabase(':memory:');
      try { await assert.rejects(async () => start({ db, port: 0, host }), /literal IP address/); }
      finally { db.close(); }
    }
  }
});
