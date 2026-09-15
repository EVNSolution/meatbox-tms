const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const errors = {
  unavailable: { status: 404, body: { error: 'DISPATCH_DATA_UNAVAILABLE' } },
  notFound: { status: 404, body: { error: 'DISPATCH_DATA_NOT_FOUND' } },
  badRequest: { status: 400, body: { error: 'DISPATCH_DATA_QUERY_INVALID' } },
  invalid: { status: 500, body: { error: 'DISPATCH_DATA_INVALID' } },
};

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function jsonError(res, error) {
  return res.status(error.status).json(error.body);
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !validDate(value.defaultDate)
    || !Array.isArray(value.dates) || value.dates.length === 0) return false;
  const dates = value.dates.map(item => item && typeof item === 'object' && !Array.isArray(item) ? item.date : null);
  return dates.every(validDate) && new Set(dates).size === dates.length && dates.includes(value.defaultDate);
}

async function readManifest(directory) {
  try {
    const raw = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw);
    if (!validateManifest(manifest)) throw new Error('invalid manifest');
    return { manifest, error: null };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { manifest: null, error: errors.unavailable };
    return { manifest: null, error: errors.invalid };
  }
}

async function isFile(filename) {
  try { return (await fs.stat(filename)).isFile(); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function manifestSignature(manifest) {
  const shift = manifest.source?.dateShift;
  const value = [
    manifest.source?.csvSha256 ?? null,
    shift ? [shift.sourceDate, shift.operatingDate, shift.offsetDays] : null,
    manifest.dates.map(item => item.date).sort(),
  ];
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateDestinationCatalog(value, manifest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !Array.isArray(value.destinations)
    || value.source?.csvSha256 !== manifest.source?.csvSha256
    || value.source?.manifestSignature !== manifestSignature(manifest)
    || !sameJson(value.source?.dateShift, manifest.source?.dateShift)) return false;
  const dates = new Set(manifest.dates.map(item => item.date));
  const ids = new Set();
  for (const item of value.destinations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !['id', 'name', 'address', 'detailAddress'].every(key => typeof item[key] === 'string')
      || !item.id || ids.has(item.id) || !Array.isArray(item.dates) || !item.dates.length) return false;
    ids.add(item.id);
    let previousDate = '';
    for (const day of item.dates) {
      if (!day || typeof day !== 'object' || Array.isArray(day)
        || !dates.has(day.date) || day.date <= previousDate || !Array.isArray(day.regionNames)
        || !day.regionNames.every(region => typeof region === 'string')
        || !Number.isInteger(day.orderCount) || day.orderCount < 0
        || !Number.isFinite(day.boxCount) || day.boxCount < 0) return false;
      previousDate = day.date;
    }
  }
  return true;
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function destinationSnapshot(catalog, date) {
  const items = [];
  let orders = 0;
  let boxes = 0;
  for (const destination of catalog.destinations) {
    const included = destination.dates.filter(day => day.date <= date);
    if (!included.length) continue;
    const regionNames = [...new Set(included.flatMap(day => day.regionNames))].sort((a, b) => a.localeCompare(b, 'ko'));
    const orderCount = included.reduce((sum, day) => sum + day.orderCount, 0);
    const boxCount = included.reduce((sum, day) => sum + day.boxCount, 0);
    const name = /[\p{L}\p{N}]/u.test(destination.name) ? destination.name : destination.address;
    const item = {
      id: destination.id,
      name,
      address: destination.address,
      detailAddress: destination.detailAddress,
      regionNames,
      orderCount,
      boxCount,
      orderDays: included.length,
      firstOrderDate: included[0].date,
      lastOrderDate: included[included.length - 1].date,
    };
    item.sortName = item.name.replace(/^[^\p{L}\p{N}]+/u, '') || item.name;
    item.searchText = [item.name, item.address, item.detailAddress, ...regionNames].join(' ').toLocaleLowerCase('ko-KR');
    items.push(item);
    orders += orderCount;
    boxes += boxCount;
  }
  const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
  items.sort((left, right) => collator.compare(left.sortName, right.sortName) || left.id.localeCompare(right.id));
  return { items, summary: { destinations: items.length, orders, boxes } };
}

async function sendJsonFile(req, res, filename) {
  if (!await isFile(filename)) return jsonError(res, errors.notFound);
  const compressed = `${filename}.gz`;
  const hasGzip = await isFile(compressed);
  const useGzip = req.acceptsEncodings('gzip') === 'gzip' && hasGzip;
  if (hasGzip) res.vary('Accept-Encoding');
  res.type('json');
  if (useGzip) res.set('Content-Encoding', 'gzip');
  const selected = useGzip ? compressed : filename;
  return new Promise(resolve => {
    res.sendFile(path.basename(selected), { root: path.dirname(selected), dotfiles: 'deny' }, error => {
      if (!error) return resolve();
      if (!res.headersSent) {
        res.removeHeader('Content-Encoding');
        jsonError(res, error.status === 404 ? errors.notFound : errors.invalid);
      }
      else res.destroy();
      resolve();
    });
  });
}

function createDispatchDataRouter({ directory = path.resolve(__dirname, '../.runtime/dispatch-data') } = {}) {
  const root = path.resolve(directory);
  const router = express.Router();
  let catalogCache = null;
  let snapshotCache = null;

  async function readDestinationCatalog(manifest) {
    const filename = path.join(root, 'destinations.json');
    const signature = manifestSignature(manifest);
    let stat;
    try {
      stat = await fs.stat(filename);
      if (!stat.isFile()) return { catalog: null, error: errors.notFound };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { catalog: null, error: errors.notFound };
      throw error;
    }
    if (catalogCache?.mtimeMs === stat.mtimeMs && catalogCache?.size === stat.size
      && catalogCache?.manifestSignature === signature) {
      return { catalog: catalogCache.catalog, error: null };
    }
    try {
      const catalog = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (!validateDestinationCatalog(catalog, manifest)) return { catalog: null, error: errors.invalid };
      catalogCache = { mtimeMs: stat.mtimeMs, size: stat.size, manifestSignature: signature, catalog };
      snapshotCache = null;
      return { catalog, error: null };
    } catch (error) {
      return { catalog: null, error: errors.invalid };
    }
  }

  router.get('/manifest', asyncRoute(async (req, res) => {
    const { error } = await readManifest(root);
    if (error) return jsonError(res, error);
    return sendJsonFile(req, res, path.join(root, 'manifest.json'));
  }));

  router.get('/days/:date', asyncRoute(async (req, res) => {
    if (!validDate(req.params.date)) return jsonError(res, errors.notFound);
    const { manifest, error } = await readManifest(root);
    if (error) return jsonError(res, error);
    if (!manifest.dates.some(item => item.date === req.params.date)) return jsonError(res, errors.notFound);
    return sendJsonFile(req, res, path.join(root, 'days', `${req.params.date}.json`));
  }));

  router.get('/regions', asyncRoute(async (req, res) => {
    const { error } = await readManifest(root);
    if (error) return jsonError(res, error);
    return sendJsonFile(req, res, path.join(root, 'regions.geojson'));
  }));

  router.get('/destinations', asyncRoute(async (req, res) => {
    const { manifest, error } = await readManifest(root);
    if (error) return jsonError(res, error);
    const date = req.query.date === undefined ? manifest.defaultDate : req.query.date;
    const q = req.query.q === undefined ? '' : req.query.q;
    const page = positiveInteger(req.query.page, 1, 1_000_000);
    const pageSize = positiveInteger(req.query.pageSize, 20, 100);
    if (typeof date !== 'string' || !manifest.dates.some(item => item.date === date)
      || typeof q !== 'string' || q.length > 100 || page === null || pageSize === null) {
      return jsonError(res, errors.badRequest);
    }
    const loaded = await readDestinationCatalog(manifest);
    if (loaded.error) return jsonError(res, loaded.error);
    if (!snapshotCache || snapshotCache.catalog !== loaded.catalog || snapshotCache.date !== date) {
      snapshotCache = { catalog: loaded.catalog, date, ...destinationSnapshot(loaded.catalog, date) };
    }
    const query = q.trim().toLocaleLowerCase('ko-KR');
    const matches = query ? snapshotCache.items.filter(item => item.searchText.includes(query)) : snapshotCache.items;
    const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
    const currentPage = Math.min(page, pageCount);
    const start = (currentPage - 1) * pageSize;
    const items = matches.slice(start, start + pageSize).map(({ searchText: _searchText, sortName: _sortName, ...item }) => item);
    const dates = manifest.dates.map(item => item.date).filter(item => item <= date).sort();
    return res.json({
      date,
      fromDate: dates[0],
      total: matches.length,
      page: currentPage,
      pageSize,
      pageCount,
      summary: snapshotCache.summary,
      items,
    });
  }));

  router.use((_req, res) => jsonError(res, errors.notFound));
  router.use((_error, _req, res, _next) => jsonError(res, errors.invalid));
  return router;
}

module.exports = { createDispatchDataRouter };
