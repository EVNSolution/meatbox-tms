const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const zlib = require('node:zlib');

const knownCommands = new Set(['set_scenario', 'arrive_stop', 'complete_stop', 'set_route_order', 'toggle_skip', 'set_delivery_tip', 'send_customer_notice', 'reassign', 'reset', 'calculate_dispatch', 'publish_dispatch']);
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
let sourceOperationsModule;

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function fail(status, error) {
  const failure = new Error(error);
  failure.status = status;
  failure.code = error;
  return failure;
}

async function loadManifest(directory) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const dates = Array.isArray(manifest?.dates) ? manifest.dates.map(item => item?.date) : [];
    if (manifest?.schemaVersion !== 1 || !validDate(manifest.defaultDate) || !dates.length
      || dates.some(date => !validDate(date)) || new Set(dates).size !== dates.length || !dates.includes(manifest.defaultDate)) {
      throw fail(500, 'DISPATCH_DATA_INVALID');
    }
    return manifest;
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw fail(404, 'DISPATCH_DATA_UNAVAILABLE');
    throw fail(500, 'DISPATCH_DATA_INVALID');
  }
}

async function loadDay(directory, date) {
  try { return JSON.parse(await fs.readFile(path.join(directory, 'days', `${date}.json`), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw fail(404, 'DISPATCH_DATA_NOT_FOUND');
    throw fail(500, 'DISPATCH_DATA_INVALID');
  }
}

function sendJSON(req, res, value) {
  const json = Buffer.from(JSON.stringify(value));
  res.type('json').vary('Accept-Encoding');
  if (req.acceptsEncodings('gzip') === 'gzip') {
    try { return res.set('Content-Encoding', 'gzip').send(zlib.gzipSync(json)); }
    catch { res.removeHeader('Content-Encoding'); }
  }
  return res.send(json);
}

function createSourceOperationsRouter({ directory = path.resolve(__dirname, '../.runtime/dispatch-data'), origin, maxEngines = 8, calculator = null } = {}) {
  if (!origin || new URL(origin).origin !== origin) throw new TypeError('origin must be an exact origin');
  const root = path.resolve(directory);
  const router = express.Router();
  const boot = randomUUID();
  const engines = new Map();
  const loading = new Map();
  const checkpoints = new Map();
  const commandLimits = new Map();
  const json = express.json({ limit: '128kb', strict: true, type: 'application/json' });

  function limitCommands(req, res, next) {
    const key = req.user?.username || req.ip;
    const now = Date.now();
    let item = commandLimits.get(key);
    if (!item || item.until <= now) {
      item = { count: 0, until: now + 60_000 };
      commandLimits.set(key, item);
    }
    if (++item.count > 120) {
      return res.status(429).set('Retry-After', String(Math.ceil((item.until - now) / 1000))).json({ error: 'COMMAND_RATE_LIMITED' });
    }
    return next();
  }

  async function createEntry(date) {
    const manifest = await loadManifest(root);
    if (!validDate(date) || !manifest.dates.some(item => item.date === date)) throw fail(404, 'DISPATCH_DATA_NOT_FOUND');
    const day = await loadDay(root, date);
    sourceOperationsModule ||= import('./dispatch-operations.mjs');
    const { createDispatchOperations } = await sourceOperationsModule;
    const sourceId = manifest.source?.csvSha256 || '';
    let checkpoint = checkpoints.get(date);
    if (checkpoint && (checkpoint.date !== date || checkpoint.sourceId !== sourceId)) {
      checkpoints.delete(date);
      checkpoint = null;
    }
    const engine = createDispatchOperations(day, {
      operatingDate: manifest.source?.dateShift?.operatingDate || manifest.defaultDate,
      calculator,
      sourceId,
      now: Date.now,
      checkpoint,
    });
    checkpoints.delete(date);
    return { engine, encoded: null };
  }

  function touch(date, entry) {
    engines.delete(date);
    engines.set(date, entry);
    return entry;
  }

  async function engineFor(date) {
    if (engines.has(date)) return touch(date, engines.get(date));
    if (loading.has(date)) return loading.get(date);
    if (engines.size + loading.size >= maxEngines) {
      const oldest = engines.entries().next().value;
      if (!oldest) throw fail(503, 'SOURCE_OPERATIONS_CAPACITY');
      const [oldestDate, oldestEntry] = oldest;
      const revision = oldestEntry.engine.revision ?? oldestEntry.engine.snapshot().revision;
      if (revision !== 0) checkpoints.set(oldestDate, oldestEntry.engine.exportCheckpoint());
      else checkpoints.delete(oldestDate);
      engines.delete(oldestDate);
    }
    const pending = createEntry(date).then(entry => touch(date, entry)).finally(() => loading.delete(date));
    loading.set(date, pending);
    return pending;
  }

  function publicState(state) { return { ...state, boot }; }
  function statePayload(entry, wantsGzip) {
    const revision = entry.engine.revision ?? entry.engine.snapshot().revision;
    if (entry.encoded?.revision !== revision) {
      const state = publicState(entry.engine.snapshot());
      entry.encoded = { revision: state.revision, json: Buffer.from(JSON.stringify(state)), gzip: null };
    }
    if (wantsGzip && !entry.encoded.gzip) entry.encoded.gzip = zlib.gzipSync(entry.encoded.json);
    return { revision, encoded: entry.encoded };
  }

  router.get('/days/:date/state', asyncRoute(async (req, res) => {
    const entry = await engineFor(req.params.date);
    const wantsGzip = req.acceptsEncodings('gzip') === 'gzip';
    const { revision, encoded } = statePayload(entry, false);
    const etag = `"source-${boot}-${req.params.date}-${revision}"`;
    res.set('ETag', etag).vary('Accept-Encoding').type('json');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    if (wantsGzip) {
      try { return res.set('Content-Encoding', 'gzip').send(statePayload(entry, true).encoded.gzip); }
      catch { res.removeHeader('Content-Encoding'); }
    }
    return res.send(encoded.json);
  }));

  router.post('/days/:date/commands', (req, res, next) => {
    if (req.headers.origin !== origin) return res.status(403).json({ error: 'ORIGIN_REQUIRED' });
    return limitCommands(req, res, () => json(req, res, next));
  }, asyncRoute(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || !knownCommands.has(req.body.type)) {
      return res.status(400).json({ error: 'INVALID_COMMAND' });
    }
    if (typeof req.body.expectedBoot !== 'string') return res.status(400).json({ error: 'INVALID_COMMAND' });
    if (req.body.expectedBoot !== boot) return res.status(409).json({ error: 'BOOT_MISMATCH', message: '서버가 다시 시작되었습니다. 최신 상태를 다시 불러와 주세요.' });
    const entry = await engineFor(req.params.date);
    try {
      const { expectedBoot: _expectedBoot, ...command } = req.body;
      const output = await entry.engine.command(command);
      entry.encoded = null;
      return sendJSON(req, res, { state: publicState(output.state), result: output.result });
    } catch (error) {
      const status = error.status === 409 ? 409 : 400;
      return res.status(status).json({ error: error.code || (status === 409 ? 'REVISION_CONFLICT' : 'INVALID_COMMAND'), message: String(error.message || '명령을 확인해 주세요.').slice(0, 300) });
    }
  }));

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'COMMAND_TOO_LARGE' });
    const status = error.status === 404 || error.status === 503 ? error.status : error.status === 409 ? 409 : error.status === 400 || error instanceof SyntaxError ? 400 : 500;
    const code = status === 400 ? 'INVALID_COMMAND' : error.code || 'SOURCE_OPERATIONS_INVALID';
    return res.status(status).json({ error: code });
  });
  return router;
}

module.exports = { createSourceOperationsRouter };
