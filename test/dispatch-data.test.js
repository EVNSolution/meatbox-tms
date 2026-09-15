const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createDispatchDataRouter } = require('../lib/dispatch-data');

function manifestSignature(manifest) {
  const shift = manifest.source?.dateShift;
  return crypto.createHash('sha256').update(JSON.stringify([
    manifest.source?.csvSha256 ?? null,
    shift ? [shift.sourceDate, shift.operatingDate, shift.offsetDays] : null,
    manifest.dates.map(item => item.date).sort(),
  ])).digest('hex');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-dispatch-data-'));
  const directory = path.join(root, '.runtime', 'dispatch-data');
  await fs.mkdir(path.join(directory, 'days'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    defaultDate: '2025-09-15',
    dates: [{ date: '2025-09-15', orderCount: 2 }, { date: '2025-09-17', orderCount: 3 }],
    source: { csvSha256: 'fixture-hash' },
  };
  const day = { date: '2025-09-15', orders: [{ id: 'A' }, { id: 'B' }] };
  const regions = { type: 'FeatureCollection', features: [] };
  const destinations = {
    schemaVersion: 1,
    source: { csvSha256: 'fixture-hash', manifestSignature: manifestSignature(manifest) },
    destinations: [
      {
        id: 'dst_b', name: ',나상점', address: '서울 주소', detailAddress: '101호', buyer: 'must-not-leak',
        dates: [
          { date: '2025-09-15', regionNames: ['서울'], orderCount: 2, boxCount: 3 },
          { date: '2025-09-17', regionNames: ['경기'], orderCount: 1, boxCount: 2 },
        ],
      },
      {
        id: 'dst_a', name: '-', address: '가상점 주소', detailAddress: '101호',
        dates: [{ date: '2025-09-15', regionNames: ['서울'], orderCount: 1, boxCount: 4 }],
      },
      {
        id: 'dst_c', name: '다상점', address: '인천 주소', detailAddress: '',
        dates: [{ date: '2025-09-17', regionNames: ['인천'], orderCount: 2, boxCount: 6 }],
      },
    ],
  };
  for (const [filename, value] of [
    ['manifest.json', manifest],
    ['days/2025-09-15.json', day],
    ['regions.geojson', regions],
    ['destinations.json', destinations],
  ]) {
    const body = Buffer.from(JSON.stringify(value));
    await fs.writeFile(path.join(directory, filename), body);
    await fs.writeFile(path.join(directory, `${filename}.gz`), zlib.gzipSync(body));
  }
  const app = express();
  app.use('/api/dispatch-data', createDispatchDataRouter({ directory }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { directory, base: `http://127.0.0.1:${server.address().port}/api/dispatch-data`, manifest, day, regions, destinations };
}

test('manifest, selected day and regions are served as JSON', async t => {
  const data = await fixture(t);
  for (const [route, expected] of [['/manifest', data.manifest], ['/days/2025-09-15', data.day], ['/regions', data.regions]]) {
    const response = await fetch(data.base + route, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /^application\/json\b/);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.deepEqual(await response.json(), expected);
  }
});

test('gzip companion is negotiated and has the same JSON meaning', async t => {
  const data = await fixture(t);
  const response = await fetch(data.base + '/days/2025-09-15', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('vary'), 'Accept-Encoding');
  assert.deepEqual(await response.json(), data.day);
});

test('gzip transfer failure clears the encoding header before the JSON error', async t => {
  const data = await fixture(t);
  const app = express();
  app.use((_req, res, next) => {
    res.sendFile = (_filename, _options, done) => done(Object.assign(new Error('transfer failed'), { status: 500 }));
    next();
  });
  app.use(createDispatchDataRouter({ directory: data.directory }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/days/2025-09-15`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.deepEqual(await response.json(), { error: 'DISPATCH_DATA_INVALID' });
});

test('missing installation and corrupt manifests return stable errors without paths', async t => {
  const data = await fixture(t);
  const absent = express();
  absent.use(createDispatchDataRouter({ directory: path.join(data.directory, 'absent') }));
  const absentServer = absent.listen(0, '127.0.0.1');
  await new Promise(resolve => absentServer.once('listening', resolve));
  t.after(() => new Promise(resolve => absentServer.close(resolve)));
  const absentResponse = await fetch(`http://127.0.0.1:${absentServer.address().port}/manifest`);
  assert.equal(absentResponse.status, 404);
  assert.deepEqual(await absentResponse.json(), { error: 'DISPATCH_DATA_UNAVAILABLE' });

  await fs.writeFile(path.join(data.directory, 'manifest.json'), '{broken');
  const corrupt = await fetch(data.base + '/manifest');
  assert.equal(corrupt.status, 500);
  assert.deepEqual(await corrupt.json(), { error: 'DISPATCH_DATA_INVALID' });
  assert.doesNotMatch(await (await fetch(data.base + '/manifest')).text(), new RegExp(data.directory));
});

test('date input is calendar-valid, allowlisted and cannot select arbitrary files', async t => {
  const data = await fixture(t);
  for (const route of [
    '/days/2025-02-30',
    '/days/2025-99-99',
    '/days/2025-09-16',
    '/days/%2e%2e%2fmanifest',
    '/days/..%5cmanifest',
    '/days/2025-09-15.json',
    '/other',
  ]) {
    const response = await fetch(data.base + route);
    assert.equal(response.status, 404, route);
    assert.deepEqual(await response.json(), { error: 'DISPATCH_DATA_NOT_FOUND' }, route);
  }

  await fs.rm(path.join(data.directory, 'days/2025-09-15.json'));
  await fs.rm(path.join(data.directory, 'days/2025-09-15.json.gz'));
  const missingDay = await fetch(data.base + '/days/2025-09-15');
  assert.equal(missingDay.status, 404);
  assert.deepEqual(await missingDay.json(), { error: 'DISPATCH_DATA_NOT_FOUND' });
});

test('cumulative destinations exclude future dates and never expose source identity fields', async t => {
  const data = await fixture(t);
  const response = await fetch(data.base + '/destinations');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    date: '2025-09-15',
    fromDate: '2025-09-15',
    total: 2,
    page: 1,
    pageSize: 20,
    pageCount: 1,
    summary: { destinations: 2, orders: 3, boxes: 7 },
    items: [
      {
        id: 'dst_a', name: '가상점 주소', address: '가상점 주소', detailAddress: '101호', regionNames: ['서울'],
        orderCount: 1, boxCount: 4, orderDays: 1, firstOrderDate: '2025-09-15', lastOrderDate: '2025-09-15',
      },
      {
        id: 'dst_b', name: ',나상점', address: '서울 주소', detailAddress: '101호', regionNames: ['서울'],
        orderCount: 2, boxCount: 3, orderDays: 1, firstOrderDate: '2025-09-15', lastOrderDate: '2025-09-15',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(body), /must-not-leak|buyer|payment|orderId/);
});

test('destination search, paging and as-of summaries are stable', async t => {
  const data = await fixture(t);
  const first = await (await fetch(data.base + '/destinations?date=2025-09-17&q=%EC%83%81%EC%A0%90&page=1&pageSize=1')).json();
  assert.equal(first.total, 3);
  assert.equal(first.pageCount, 3);
  assert.deepEqual(first.summary, { destinations: 3, orders: 6, boxes: 15 });
  assert.equal(first.items[0].name, '가상점 주소');
  const second = await (await fetch(data.base + '/destinations?date=2025-09-17&q=%EC%83%81%EC%A0%90&page=2&pageSize=1')).json();
  assert.equal(second.items[0].name, ',나상점');
  assert.deepEqual(second.items[0].regionNames, ['경기', '서울']);
  assert.equal(second.items[0].orderDays, 2);
  assert.equal(second.items[0].lastOrderDate, '2025-09-17');

  const clamped = await (await fetch(data.base + '/destinations?date=2025-09-17&q=%EC%83%81%EC%A0%90&page=999&pageSize=1')).json();
  assert.equal(clamped.page, 3);
  assert.equal(clamped.pageCount, 3);
  assert.equal(clamped.items[0].name, '다상점');

  const empty = await (await fetch(data.base + '/destinations?q=not-found&page=999')).json();
  assert.equal(empty.total, 0);
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.deepEqual(empty.items, []);
});

test('destination catalog cache rejects a changed manifest date set', async t => {
  const data = await fixture(t);
  assert.equal((await fetch(data.base + '/destinations')).status, 200);
  const changed = { ...data.manifest, dates: [...data.manifest.dates, { date: '2025-09-18', orderCount: 1 }] };
  await fs.writeFile(path.join(data.directory, 'manifest.json'), JSON.stringify(changed));
  const response = await fetch(data.base + '/destinations');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'DISPATCH_DATA_INVALID' });
});

test('destination query validates bounds and missing catalogs do not fall back to day orders', async t => {
  const data = await fixture(t);
  for (const query of [
    '?date=2025-09-16', '?page=0', '?page=-1', '?page=1000001', '?pageSize=101',
    `?q=${'x'.repeat(101)}`, '?page=1&page=2', '?q=x&q=y',
  ]) {
    const response = await fetch(data.base + '/destinations' + query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'DISPATCH_DATA_QUERY_INVALID' }, query);
  }

  await fs.rm(path.join(data.directory, 'destinations.json'));
  await fs.rm(path.join(data.directory, 'destinations.json.gz'));
  const missing = await fetch(data.base + '/destinations');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'DISPATCH_DATA_NOT_FOUND' });
});
