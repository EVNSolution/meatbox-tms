const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createDemo } = require('../server');

const origin = 'http://127.0.0.1:32123';
const date = '2025-09-15';
const groups = [
  { id: 'G1', label: '기사 1', regionNames: ['서울'] },
  { id: 'G2', label: '기사 2', regionNames: ['경기'] },
];
const orders = [
  { id: 'O1', groupId: 'G1', orderNumber: '1001', name: '매장 1', address: '서울 1', detailAddress: '1층', boxes: 3, sourceRows: 3, sequence: 1, regionCode: '01', regionName: '서울', coordinates: [127.1, 37.5], zoneIds: ['Z1'] },
  { id: 'O2', groupId: 'G1', orderNumber: '1002', name: '매장 2', address: '서울 2', detailAddress: '2층', boxes: 7, sourceRows: 7, sequence: 2, regionCode: '01', regionName: '서울', coordinates: [127.2, 37.6], zoneIds: ['Z1'] },
  { id: 'O3', groupId: 'G2', orderNumber: '1003', name: '매장 3', address: '경기 1', detailAddress: '', boxes: 11, sourceRows: 11, sequence: 3, regionCode: '02', regionName: '경기', coordinates: [127.3, 37.7], zoneIds: ['Z2'] },
];
const day = {
  schemaVersion: 1,
  date,
  weekday: '월요일',
  summary: { sourceRows: 21, boxes: 21, orders: 3, payments: 3, sites: 3, groups: 2, mappedOrders: 3, unmappedOrders: 0, uncoveredOrders: 0, multiZoneOrders: 0 },
  groups,
  orders,
};

function assignInOrder({ orders: sourceOrders, vehicleIds }) {
  return Object.fromEntries(sourceOrders.map((order, index) => [order.id, vehicleIds[index % vehicleIds.length]]));
}

async function fixture(t, { dispatchCalculator = assignInOrder, operatingDate = date } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-source-api-'));
  const dispatchDataDir = path.join(root, '.runtime', 'dispatch-data');
  await fs.mkdir(path.join(dispatchDataDir, 'days'), { recursive: true });
  await fs.writeFile(path.join(dispatchDataDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    defaultDate: date,
    dates: [{ date, weekday: '월요일', summary: day.summary }],
    source: { csvSha256: 'csv-test-source', dateShift: { operatingDate } },
  }));
  await fs.writeFile(path.join(dispatchDataDir, 'days', `${date}.json`), JSON.stringify(day));
  await fs.writeFile(path.join(dispatchDataDir, 'regions.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
  const demo = createDemo({ accessFile: path.join(root, 'access.json'), dispatchDataDir, origin, ...(dispatchCalculator === 'default' ? {} : { dispatchCalculator }) });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${demo.server.address().port}`;
  const invite = await demo.access.issueInvite();
  const credentials = { username: 'source-reviewer', password: 'demo1234' };
  await demo.access.register({ ...credentials, invite });
  const session = await demo.access.login(credentials);
  const cookie = `meatbox_session=${session.token}`;
  t.after(async () => { await demo.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, options = {}) => fetch(base + route, {
    redirect: 'manual',
    ...options,
    headers: { cookie, 'accept-encoding': 'identity', ...options.headers },
  });
  return { base, cookie, request, dispatchDataDir, access: demo.access };
}

async function command(api, itemDate, body, requestOrigin = origin, encoding = 'identity') {
  return api.request(`/api/dispatch-data/days/${itemDate}/commands`, {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json', 'accept-encoding': encoding },
    body: JSON.stringify(body),
  });
}

async function calculate(api, itemDate = date, vehicleIds = ['G1', 'G2']) {
  const state = await (await api.request(`/api/dispatch-data/days/${itemDate}/state`)).json();
  const response = await command(api, itemDate, {
    type: 'calculate_dispatch', expectedBoot: state.boot, expectedRevision: state.revision, vehicleIds,
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function publish(api, itemDate = date) {
  const calculated = await calculate(api, itemDate);
  const response = await command(api, itemDate, {
    type: 'publish_dispatch',
    expectedBoot: calculated.state.boot,
    expectedRevision: calculated.state.revision,
    draftVersion: calculated.state.dispatch.draftVersion,
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('source state is authenticated, revision-cached and gzip negotiable', async t => {
  const api = await fixture(t);
  const route = `/api/dispatch-data/days/${date}/state`;
  const denied = await fetch(api.base + route, { redirect: 'manual' });
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: 'LOGIN_REQUIRED' });

  const first = await api.request(route);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /^application\/json\b/);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('content-encoding'), null);
  const etag = first.headers.get('etag');
  const state = await first.json();
  assert.match(state.boot, /^[0-9a-f-]{36}$/);
  assert.equal(state.revision, 0);
  assert.equal(state.sourceData.date, date);
  assert.equal(state.sourceData.sourceId, 'csv-test-source');
  assert.equal(state.dispatch.phase, 'unplanned');
  assert.equal(state.dispatch.readOnly, false);
  assert.equal(state.fleetDeliveries.length, 0);
  assert.equal(state.dispatchOrders.length, orders.length);

  const unchanged = await api.request(route, { headers: { 'if-none-match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  const compressed = await api.request(route, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
  assert.deepEqual(await compressed.json(), state);
});

test('gzip failures fall back to truthful plain JSON without losing commands', async t => {
  const api = await fixture(t);
  const stateRoute = `/api/dispatch-data/days/${date}/state`;
  const commandRoute = `/api/dispatch-data/days/${date}/commands`;
  const initial = await (await api.request(stateRoute)).json();
  const gzipSync = zlib.gzipSync;
  zlib.gzipSync = () => { throw new Error('injected gzip failure'); };
  try {
    const stateResponse = await api.request(stateRoute, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.headers.get('content-encoding'), null);
    assert.deepEqual(await stateResponse.json(), initial);

    const commandResponse = await api.request(commandRoute, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      body: JSON.stringify({ type: 'calculate_dispatch', expectedBoot: initial.boot, expectedRevision: initial.revision, vehicleIds: ['G1', 'G2'] }),
    });
    assert.equal(commandResponse.status, 200);
    assert.equal(commandResponse.headers.get('content-encoding'), null);
    const changed = await commandResponse.json();
    assert.equal(changed.state.revision, 1);
    assert.equal(changed.state.dispatch.phase, 'draft');
  } finally {
    zlib.gzipSync = gzipSync;
  }
});

test('same-origin commands share state and reject stale revision or server boot', async t => {
  const api = await fixture(t);
  const stateRoute = `/api/dispatch-data/days/${date}/state`;
  const commandRoute = `/api/dispatch-data/days/${date}/commands`;
  const initialResponse = await api.request(stateRoute);
  const initialEtag = initialResponse.headers.get('etag');
  const initial = await initialResponse.json();
  const post = (body, requestOrigin = origin, encoding = 'identity') => api.request(commandRoute, {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json', 'accept-encoding': encoding },
    body: JSON.stringify(body),
  });

  const wrongOrigin = await post({ type: 'reset', expectedRevision: 0, expectedBoot: initial.boot }, 'https://attacker.invalid');
  assert.equal(wrongOrigin.status, 403);
  assert.deepEqual(await wrongOrigin.json(), { error: 'ORIGIN_REQUIRED' });
  const wrongBoot = await post({ type: 'reset', expectedRevision: 0, expectedBoot: 'old-process' });
  assert.equal(wrongBoot.status, 409);
  assert.deepEqual(await wrongBoot.json(), { error: 'BOOT_MISMATCH', message: '서버가 다시 시작되었습니다. 최신 상태를 다시 불러와 주세요.' });

  const calculated = await post({ type: 'calculate_dispatch', expectedRevision: initial.revision, expectedBoot: initial.boot, vehicleIds: ['G1', 'G2'] }, origin, 'gzip');
  assert.equal(calculated.status, 200);
  assert.equal(calculated.headers.get('content-encoding'), 'gzip');
  const changed = await calculated.json();
  assert.equal(changed.state.boot, initial.boot);
  assert.equal(changed.state.revision, initial.revision + 1);
  assert.equal(changed.state.dispatch.phase, 'draft');
  assert.equal(changed.state.fleetDeliveries.length, 0);

  const refreshed = await api.request(stateRoute, { headers: { 'if-none-match': initialEtag } });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.headers.get('etag'), initialEtag);
  const shared = await refreshed.json();
  assert.equal(shared.revision, changed.state.revision);
  assert.equal(shared.dispatch.phase, 'draft');
  const stale = await post({ type: 'calculate_dispatch', expectedRevision: initial.revision, expectedBoot: initial.boot, vehicleIds: ['G1', 'G2'] });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.error, 'REVISION_CONFLICT');
  assert.match(staleBody.message, /최신|상태|revision|리비전/i);
});

test('orders stay unassigned until a calculated draft is published', async t => {
  const api = await fixture(t);
  const initial = await (await api.request(`/api/dispatch-data/days/${date}/state`)).json();
  assert.equal(initial.dispatch.phase, 'unplanned');
  assert.equal(initial.fleetDeliveries.length, 0);
  assert.deepEqual(initial.dispatchOrders.map(order => order.id), orders.map(order => order.id));

  const calculated = await calculate(api);
  assert.equal(calculated.state.dispatch.phase, 'draft');
  assert.equal(calculated.state.fleetDeliveries.length, 0);
  assert.equal(calculated.state.dispatchPreview.reduce((sum, vehicle) => sum + vehicle.orders, 0), orders.length);

  const response = await command(api, date, {
    type: 'publish_dispatch',
    expectedBoot: calculated.state.boot,
    expectedRevision: calculated.state.revision,
    draftVersion: calculated.state.dispatch.draftVersion,
  });
  assert.equal(response.status, 200);
  const published = await response.json();
  assert.equal(published.state.dispatch.phase, 'published');
  assert.equal(published.state.fleetDeliveries.length, orders.length);
  assert.deepEqual(Object.fromEntries(published.state.fleetDeliveries.map(order => [order.id, order.vehicleId])), {
    O1: 'G1', O2: 'G2', O3: 'G1',
  });
});

test('past dates expose records but reject dispatch mutations', async t => {
  const api = await fixture(t, { operatingDate: '2025-09-16' });
  const initial = await (await api.request(`/api/dispatch-data/days/${date}/state`)).json();
  assert.equal(initial.dispatch.readOnly, true);

  const response = await command(api, date, {
    type: 'calculate_dispatch', expectedBoot: initial.boot, expectedRevision: initial.revision, vehicleIds: ['G1', 'G2'],
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'DATE_READ_ONLY', message: '과거 배차일은 조회만 할 수 있습니다.' });
});

test('published routes retain ordered stops', async t => {
  const api = await fixture(t);
  const published = await publish(api);
  const vehicleId = 'G1';
  const route = published.state.fleetDeliveries.filter(order => order.vehicleId === vehicleId);
  assert.equal(route.length, 2);

  const response = await command(api, date, {
    type: 'set_route_order',
    expectedBoot: published.state.boot,
    expectedRevision: published.state.revision,
    vehicleId,
    order: route.map(order => order.id).reverse(),
    expectedOrder: route.map(order => order.id),
    expectedStatuses: route.map(order => order.status),
    expectedPhase: published.state.vehicleStates[vehicleId].phase,
  });
  assert.equal(response.status, 200);
  const changed = await response.json();
  assert.deepEqual(changed.state.fleetDeliveries.filter(order => order.vehicleId === vehicleId).map(order => order.id), ['O3', 'O1']);
});

test('published routes retain delivery tips', async t => {
  const api = await fixture(t);
  const published = await publish(api);
  const response = await command(api, date, {
    type: 'set_delivery_tip', expectedBoot: published.state.boot, expectedRevision: published.state.revision,
    vehicleId: 'G1', stopId: 'O1', body: '후문으로 진입',
  });
  assert.equal(response.status, 200);
  const changed = await response.json();
  assert.equal(changed.state.fleetDeliveries.find(order => order.id === 'O1').tip.body, '후문으로 진입');
});

test('published routes keep customer notices linked to their destination', async t => {
  const api = await fixture(t);
  const published = await publish(api);
  const response = await command(api, date, {
    type: 'send_customer_notice', expectedBoot: published.state.boot, expectedRevision: published.state.revision,
    vehicleId: 'G1', stopId: 'O1', body: '도착 전에 연락드리겠습니다.', author: '운영자',
  });
  assert.equal(response.status, 200);
  const changed = await response.json();
  assert.equal(changed.state.notifications.at(-1).stopId, 'O1');
  assert.equal(changed.state.events.at(0).stopId, 'O1');
});

test('commands validate body and dates without exposing source paths', async t => {
  const api = await fixture(t);
  const commandRoute = `/api/dispatch-data/days/${date}/commands`;
  const headers = { origin, 'content-type': 'application/json' };
  const malformed = await api.request(commandRoute, { method: 'POST', headers, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'INVALID_COMMAND' });
  const unknown = await api.request(commandRoute, { method: 'POST', headers, body: JSON.stringify({ type: 'delete_everything', expectedBoot: 'x', expectedRevision: 0 }) });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'INVALID_COMMAND' });
  const oversized = await api.request(commandRoute, { method: 'POST', headers, body: JSON.stringify({ type: 'reset', padding: 'x'.repeat(140 * 1024) }) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'COMMAND_TOO_LARGE' });

  for (const route of [
    '/api/dispatch-data/days/2025-02-30/state',
    '/api/dispatch-data/days/2025-09-16/state',
    '/api/dispatch-data/days/%2e%2e%2fmanifest/state',
  ]) {
    const response = await api.request(route);
    assert.equal(response.status, 404, route);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(api.dispatchDataDir));
  }

  const originalRead = await api.request(`/api/dispatch-data/days/${date}`);
  assert.equal(originalRead.status, 200);
  assert.deepEqual(await originalRead.json(), day);
});

test('source state reports unavailable and corrupt files without leaking paths', async t => {
  const api = await fixture(t);
  const route = `/api/dispatch-data/days/${date}/state`;
  const manifestPath = path.join(api.dispatchDataDir, 'manifest.json');
  await fs.writeFile(manifestPath, '{broken');
  const corrupt = await api.request(route);
  assert.equal(corrupt.status, 500);
  const corruptBody = await corrupt.json();
  assert.deepEqual(corruptBody, { error: 'DISPATCH_DATA_INVALID' });

  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    defaultDate: date,
    dates: [{ date, weekday: '월요일', summary: day.summary }],
  }));
  await fs.rm(path.join(api.dispatchDataDir, 'days', `${date}.json`));
  const missingDay = await api.request(route);
  assert.equal(missingDay.status, 404);
  const missingDayBody = await missingDay.json();
  assert.deepEqual(missingDayBody, { error: 'DISPATCH_DATA_NOT_FOUND' });

  await fs.rm(manifestPath);
  const unavailable = await api.request(route);
  assert.equal(unavailable.status, 404);
  const unavailableBody = await unavailable.json();
  assert.deepEqual(unavailableBody, { error: 'DISPATCH_DATA_UNAVAILABLE' });
  assert.doesNotMatch(JSON.stringify([corruptBody, missingDayBody, unavailableBody]), new RegExp(api.dispatchDataDir));
});

test('more than eight modified dates round-trip through checkpoints with CAS continuity', async t => {
  const api = await fixture(t);
  const dates = Array.from({ length: 9 }, (_, index) => `2025-09-${String(15 + index).padStart(2, '0')}`);
  for (const itemDate of dates.slice(1)) {
    await fs.writeFile(path.join(api.dispatchDataDir, 'days', `${itemDate}.json`), JSON.stringify({ ...day, date: itemDate }));
  }
  await fs.writeFile(path.join(api.dispatchDataDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    defaultDate: date,
    dates: dates.map(itemDate => ({ date: itemDate, weekday: '월요일', summary: day.summary })),
    source: { csvSha256: 'csv-test-source', dateShift: { operatingDate: date } },
  }));

  for (const itemDate of dates) {
    const state = await (await api.request(`/api/dispatch-data/days/${itemDate}/state`)).json();
    const changed = await api.request(`/api/dispatch-data/days/${itemDate}/commands`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'calculate_dispatch', expectedBoot: state.boot, expectedRevision: state.revision, vehicleIds: ['G1', 'G2'] }),
    });
    assert.equal(changed.status, 200, itemDate);
  }

  const first = await (await api.request(`/api/dispatch-data/days/${dates[0]}/state`)).json();
  assert.equal(first.revision, 1);
  assert.equal(first.dispatch.phase, 'draft');
  assert.equal(first.fleetDeliveries.length, 0);
  const changedAgain = await api.request(`/api/dispatch-data/days/${dates[0]}/commands`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'calculate_dispatch', expectedBoot: first.boot, expectedRevision: first.revision, vehicleIds: ['G2', 'G1'] }),
  });
  assert.equal(changedAgain.status, 200);
  assert.equal((await changedAgain.json()).state.revision, 2);

  for (const itemDate of dates.slice(1)) {
    assert.equal((await api.request(`/api/dispatch-data/days/${itemDate}/state`)).status, 200);
  }
  const restoredAgain = await (await api.request(`/api/dispatch-data/days/${dates[0]}/state`)).json();
  assert.equal(restoredAgain.revision, 2);
  assert.equal(restoredAgain.dispatch.phase, 'draft');
  assert.equal(restoredAgain.dispatchPreview.find(vehicle => vehicle.vehicleId === 'G2').orders, 2);
});

test('command rate limits are isolated by authenticated user', async t => {
  const api = await fixture(t);
  const route = `/api/dispatch-data/days/${date}/commands`;
  const attempts = await Promise.all(Array.from({ length: 121 }, () => api.request(route, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'reset', expectedBoot: 'old-process', expectedRevision: 0 }),
  })));
  assert.equal(attempts.filter(response => response.status === 409).length, 120);
  assert.equal(attempts.filter(response => response.status === 429).length, 1);
  const limited = attempts.find(response => response.status === 429);
  assert.match(limited.headers.get('retry-after'), /^\d+$/);
  assert.deepEqual(await limited.json(), { error: 'COMMAND_RATE_LIMITED' });

  const invite = await api.access.issueInvite();
  const credentials = { username: 'second-source-reviewer', password: 'demo1234' };
  await api.access.register({ ...credentials, invite });
  const secondSession = await api.access.login(credentials);
  const otherUser = await fetch(api.base + route, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: `meatbox_session=${secondSession.token}`,
      origin,
      'content-type': 'application/json',
      'accept-encoding': 'identity',
    },
    body: JSON.stringify({ type: 'reset', expectedBoot: 'old-process', expectedRevision: 0 }),
  });
  assert.equal(otherUser.status, 409);
});

test('default server calculator supports review, publish, amendment, and republish over authenticated API', async t => {
  const api = await fixture(t, { dispatchCalculator: 'default' });
  let state = (await publish(api)).state;
  assert.equal(state.dispatch.phase, 'published');
  assert.equal(state.fleetDeliveries.length, orders.length);
  assert.equal(state.fleetDeliveries.reduce((sum, order) => sum + order.boxes, 0), 21);
  async function send(body) {
    const response = await command(api, date, { expectedBoot: state.boot, expectedRevision: state.revision, ...body });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    state = value.state;
  }
  const confirmed = structuredClone(state.fleetDeliveries);
  const first = confirmed[0];
  const targetVehicleId = first.vehicleId === 'G1' ? 'G2' : 'G1';
  await send({ type: 'begin_dispatch_revision' });
  await send({ type: 'reassign', orderIds: [first.id], targetVehicleId });
  assert.deepEqual(state.fleetDeliveries, confirmed);
  await send({ type: 'publish_dispatch', draftVersion: state.dispatch.draftVersion });
  assert.equal(state.fleetDeliveries.find(order => order.id === first.id).vehicleId, targetVehicleId);
  await send({ type: 'set_scenario', vehicleId: targetVehicleId, stopId: first.id, scenario: 'shipping' });
  await send({ type: 'arrive_stop', vehicleId: targetVehicleId, stopId: first.id });
  await send({ type: 'complete_stop', vehicleId: targetVehicleId, stopId: first.id, hasPhoto: true });
  assert.equal(state.fleetDeliveries.find(order => order.id === first.id).status, 'done');
  assert.equal(state.notifications.some(notice => notice.stopId === first.id && notice.kind === 'completed'), true);
  await send({ type: 'begin_dispatch_revision' });
  await send({ type: 'discard_dispatch_revision' });
  assert.equal(state.fleetDeliveries.find(order => order.id === first.id).status, 'done');
});
