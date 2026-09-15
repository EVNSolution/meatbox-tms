import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptDispatchDay, resolveDispatchDate, mountDatedDispatch as mountDatedDispatchImpl } from './dated-dispatch.mjs';

const mountDatedDispatch = options => mountDatedDispatchImpl({ workflowFactory: () => ({ update() {}, destroy() {} }), ...options, datePickerFactory: ({ element, onChange }) => {
  element.listeners.change = () => onChange(element.value);
  return { update({ value, dates, disabled }) { element.value = value; element.dates = dates; element.disabled = disabled; }, destroy() { delete element.listeners.change; } };
} });

class FakeNode {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.min = '';
    this.max = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.listeners = {};
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  dispatch(type) { this.listeners[type]?.({ target: this }); }
}

const regions = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'Z1' }, geometry: null }] };
const group = (id, label = id) => ({ id, label, regionNames: ['서울'] });
const order = (id, groupId, coordinates = [127.1, 37.5], boxes = 2) => ({ id, groupId, name: id, boxes, coordinates, zoneIds: ['Z1'] });
function day(date, orders = [order(`O-${date}`, 'G1')], groups = [group('G1')]) {
  return { schemaVersion: 1, date, weekday: '월요일', summary: { orders: orders.length, boxes: orders.reduce((sum, item) => sum + item.boxes, 0) }, groups, orders };
}
const manifest = {
  schemaVersion: 1,
  defaultDate: '2025-09-15',
  dates: [
    { date: '2025-09-15', weekday: '월요일' },
    { date: '2025-09-16', weekday: '화요일' },
    { date: '2025-09-17', weekday: '수요일' },
  ],
  source: { regionBaseDate: '2025-06-30', csvSha256: 'csv-fixture' },
};

function assignmentDay(date) {
  return day(date, [
    order('O1', 'G1', [127.1, 37.5], 3),
    order('O2', 'G1', [127.2, 37.6], 7),
    order('O3', 'G2', [127.3, 37.7], 11),
  ], [group('G1', '기사 1'), group('G2', '기사 2')]);
}

function domFixture() {
  const names = ['toolbar', 'date', 'status', 'retry', 'planning', 'workflow', 'prev', 'next', 'source-info'];
  const nodes = Object.fromEntries(names.map(name => [name, new FakeNode()]));
  nodes.toolbar.hidden = true;
  nodes.retry.hidden = true;
  nodes.planning.hidden = true;
  const element = new FakeNode();
  element.querySelector = selector => nodes[selector.match(/data-dispatch-([^\]]+)/)?.[1]];
  return { element, nodes };
}

function installBrowserGlobals(t, search = '', storage = memoryStorage()) {
  const saved = { location: globalThis.location, history: globalThis.history, sessionStorage: globalThis.sessionStorage };
  const had = {
    location: Object.hasOwn(globalThis, 'location'),
    history: Object.hasOwn(globalThis, 'history'),
    sessionStorage: Object.hasOwn(globalThis, 'sessionStorage'),
  };
  const replaced = [];
  globalThis.location = { href: `https://demo.test/combined/${search}`, search };
  globalThis.history = { replaceState(_state, _title, url) { replaced.push(String(url)); } };
  globalThis.sessionStorage = storage;
  t.after(() => {
    if (had.location) globalThis.location = saved.location; else delete globalThis.location;
    if (had.history) globalThis.history = saved.history; else delete globalThis.history;
    if (had.sessionStorage) globalThis.sessionStorage = saved.sessionStorage; else delete globalThis.sessionStorage;
  });
  return replaced;
}

function memoryStorage(initial = {}, blocked = false) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { if (blocked) throw new Error('storage blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('storage blocked'); values.set(key, String(value)); },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check) {
  for (let tries = 0; tries < 30; tries += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail('비동기 배차 갱신이 완료되지 않았습니다.');
}

function planningSpy() {
  const mounts = [];
  const factory = options => {
    const instance = { options, updates: [], destroyed: false, update(...args) { this.updates.push(args); }, destroy() { this.destroyed = true; } };
    mounts.push(instance);
    return instance;
  };
  return { factory, mounts };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('날짜 주문 어댑터는 원본과 겹친 위치의 각 주문을 그대로 보존한다', () => {
  const shared = [127.1234, 37.5678];
  const source = day('2025-09-15', [order('O1', 'G1', shared, 3), order('O2', 'G1', [...shared], 4)]);
  const before = structuredClone(source);
  const adapted = adaptDispatchDay(source, regions);
  assert.equal(adapted.dispatchSource, source);
  assert.equal(adapted.dispatchRegions, regions);
  assert.deepEqual(adapted.fleetDeliveries.map(item => [item.id, item.coordinates, item.boxes]), [
    ['O1', shared, 3], ['O2', shared, 4],
  ]);
  assert.equal(adapted.fleetVehicles[0].id, 'G1');
  assert.equal(adapted.fleetVehicles[0].driver, 'G1');
  assert.equal(adapted.fleetVehicles[0].region, '서울');
  assert.equal(adapted.fleetVehicles[0].live, false);
  assert.equal(adapted.fleetVehicles[0].source, 'demo-vehicle');
  assert.match(adapted.fleetVehicles[0].plate, /^\d{2}[가-힣] \d{4}$/);
  assert.equal(adapted.fleetVehicles[0].location.source, 'demo');
  assert.match(adapted.fleetVehicles[0].location.label, /예시 위치$/);
  assert.deepEqual(source, before);
});

test('날짜 주문 어댑터는 잘못된 수량, 좌표와 배차 그룹을 거부한다', () => {
  const cases = [
    day('2025-09-15', [order('O1', 'G1', [127, 37], -1)]),
    day('2025-09-15', [order('O1', 'G1', [181, 37], 1)]),
    day('2025-09-15', [order('O1', 'UNKNOWN', [127, 37], 1)]),
    { ...day('2025-09-15'), groups: null },
    { ...day('2025-09-15'), summary: { orders: 1 } },
    { ...day('2025-09-15'), summary: { orders: 1, boxes: NaN } },
  ];
  for (const source of cases) assert.throws(() => adaptDispatchDay(source, regions), TypeError);
});

test('요청 날짜는 원본 기본일, 허용 날짜와 미허용 기본일 복귀를 구분한다', () => {
  assert.equal(resolveDispatchDate(manifest), manifest.defaultDate);
  assert.equal(resolveDispatchDate(manifest, '2025-09-17'), '2025-09-17');
  assert.equal(resolveDispatchDate(manifest, '2026-09-16'), manifest.defaultDate);
  assert.equal(resolveDispatchDate(manifest, '../manifest'), manifest.defaultDate);
});

test('초기 갱신은 manifest, 권역, 기본일을 한 번만 읽고 미배정 주문만 렌더링한다', async t => {
  const replaced = installBrowserGlobals(t);
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const calls = [];
  const source = day(manifest.defaultDate);
  const fetchJSON = async url => {
    calls.push(url);
    if (url.endsWith('/manifest')) return manifest;
    if (url.endsWith('/regions')) return regions;
    return source;
  };
  const selected = [];
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory, onSelect: id => selected.push(id) });
  const simulation = { fleetDeliveries: [{ id: 'S1' }] };
  const before = structuredClone(simulation);
  dated.update(simulation, 'S1');
  dated.update(simulation, 'S1');
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  assert.deepEqual(calls, ['/api/dispatch-data/manifest', '/api/dispatch-data/regions', `/api/dispatch-data/days/${manifest.defaultDate}`]);
  assert.equal(planning.mounts.length, 1);
  assert.deepEqual(Object.keys(planning.mounts[0].options).sort(), ['element']);
  assert.equal('onSelect' in planning.mounts[0].options, false);
  assert.equal(planning.mounts[0].updates[0][0].dispatchSource, source);
  assert.equal(planning.mounts[0].updates[0][1], null);
  assert.deepEqual(selected, []);
  assert.deepEqual(simulation, before);
  assert.equal(nodes.planning.hidden, false);
  assert.equal(nodes.toolbar.hidden, false);
  assert.deepEqual(nodes.date.dates, manifest.dates);
  assert.equal(nodes.date.disabled, false);
  assert.doesNotMatch(element.innerHTML, /type="date"|data-dispatch-weekday|data-dispatch-date-count/);
  assert.equal(dated.summary(), source.summary);
  assert.match(replaced.at(-1), /\?date=2025-09-15$/);
  dated.destroy();
});

test('빠른 날짜 변경은 늦게 끝난 이전 응답을 버리고 최신 날짜만 표시한다', async t => {
  installBrowserGlobals(t);
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const pending16 = deferred();
  const pending17 = deferred();
  const calls = [];
  const fetchJSON = async url => {
    calls.push(url);
    if (url.endsWith('/manifest')) return manifest;
    if (url.endsWith('/regions')) return regions;
    if (url.endsWith('/2025-09-16')) return pending16.promise;
    if (url.endsWith('/2025-09-17')) return pending17.promise;
    return day('2025-09-15');
  };
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
  dated.update({}, null);
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  nodes.date.value = '2025-09-16'; nodes.date.dispatch('change');
  nodes.date.value = '2025-09-17'; nodes.date.dispatch('change');
  pending17.resolve(day('2025-09-17'));
  await waitFor(() => planning.mounts[0].updates.length === 2);
  pending16.resolve(day('2025-09-16'));
  await tick(); await tick();
  assert.deepEqual(calls.slice(-2), ['/api/dispatch-data/days/2025-09-16', '/api/dispatch-data/days/2025-09-17']);
  assert.equal(planning.mounts[0].updates.length, 2);
  assert.equal(planning.mounts[0].updates.at(-1)[0].dispatchSource.date, '2025-09-17');
  assert.equal(dated.summary().orders, 1);
  dated.destroy();
});

test('준비되지 않은 날짜는 요청하지 않고 이전 지도를 숨긴다', async t => {
  installBrowserGlobals(t);
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const calls = [];
  const fetchJSON = async url => {
    calls.push(url);
    if (url.endsWith('/manifest')) return manifest;
    if (url.endsWith('/regions')) return regions;
    return day(manifest.defaultDate);
  };
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
  dated.update({}, null);
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  const before = calls.length;
  nodes.date.value = '2025-09-14'; nodes.date.dispatch('change');
  await tick();
  assert.equal(calls.length, before);
  assert.equal(nodes.planning.hidden, true);
  assert.match(nodes.status.textContent, /배차가 없습니다/);
  assert.equal(nodes.retry.hidden, true);
  assert.equal(dated.summary(), null);
  dated.destroy();
});

test('manifest 404만 기존 시나리오로 명시적으로 복귀한다', async t => {
  installBrowserGlobals(t);
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const selected = [];
  const fetchJSON = async () => { const error = new Error('not installed'); error.status = 404; throw error; };
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory, onSelect: id => selected.push(id) });
  const simulation = { fleetDeliveries: [{ id: 'S1' }] };
  dated.update(simulation, 'S1');
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  assert.equal(dated.usesSource(), false);
  assert.equal(nodes.planning.hidden, false);
  assert.match(nodes.status.textContent, /기존 시나리오/);
  assert.equal(planning.mounts[0].options.onSelect instanceof Function, true);
  assert.deepEqual(planning.mounts[0].updates[0], [simulation, 'S1']);
  planning.mounts[0].options.onSelect('S2');
  assert.deepEqual(selected, ['S2']);
  dated.destroy();
});

test('형식 오류와 시간 초과는 가짜 기존 시나리오로 바꾸지 않는다', async t => {
  installBrowserGlobals(t);
  for (const fetchJSON of [
    async () => ({ schemaVersion: 1, dates: [] }),
    async () => { throw new Error('timeout'); },
  ]) {
    const { element, nodes } = domFixture();
    const planning = planningSpy();
    const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
    dated.update({ fleetDeliveries: [{ id: 'S1' }] }, 'S1');
    await waitFor(() => nodes.retry.hidden === false);
    assert.equal(planning.mounts.length, 0);
    assert.equal(nodes.planning.hidden, true);
    assert.doesNotMatch(nodes.status.textContent, /기존 시나리오/);
    assert.match(nodes.status.textContent, /불러오지 못했습니다/);
    dated.destroy();
  }
});

test('날짜 전환은 전달받은 시뮬레이션과 날짜 원본을 변경하지 않는다', async t => {
  installBrowserGlobals(t, '?date=2025-09-16');
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const days = Object.fromEntries(manifest.dates.map(item => [item.date, day(item.date)]));
  const beforeDays = structuredClone(days);
  const simulation = { vehicle: { id: 'V1' }, fleetDeliveries: [{ id: 'S1', boxes: 8 }] };
  const beforeSimulation = structuredClone(simulation);
  const fetchJSON = async url => url.endsWith('/manifest') ? manifest : url.endsWith('/regions') ? regions : days[url.split('/').at(-1)];
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
  dated.update(simulation, 'S1');
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  nodes.date.value = '2025-09-17'; nodes.date.dispatch('change');
  await waitFor(() => planning.mounts[0].updates.length === 2);
  assert.deepEqual(days, beforeDays);
  assert.deepEqual(simulation, beforeSimulation);
  assert.equal(planning.mounts[0].updates.at(-1)[0].dispatchSource, days['2025-09-17']);
  dated.destroy();
});

test('선택 날짜는 화면을 다시 열어도 URL 쿼리 없이 복원된다', async t => {
  const storage = memoryStorage();
  installBrowserGlobals(t, '', storage);
  const days = Object.fromEntries(manifest.dates.map(item => [item.date, day(item.date)]));
  const requested = [];
  const fetchJSON = async url => {
    if (url.endsWith('/manifest')) return manifest;
    if (url.endsWith('/regions')) return regions;
    requested.push(url.split('/').at(-1));
    return days[url.split('/').at(-1)];
  };
  const firstDOM = domFixture();
  const firstPlanning = planningSpy();
  const first = mountDatedDispatch({ element: firstDOM.element, fetchJSON, planningFactory: firstPlanning.factory });
  first.update({}, null);
  await waitFor(() => firstPlanning.mounts[0]?.updates.length === 1);
  firstDOM.nodes.date.value = '2025-09-17'; firstDOM.nodes.date.dispatch('change');
  await waitFor(() => firstPlanning.mounts[0].updates.length === 2);
  assert.equal(storage.values.get('meatbox.dispatch.date'), '2025-09-17');
  first.destroy();

  const secondDOM = domFixture();
  const secondPlanning = planningSpy();
  const second = mountDatedDispatch({ element: secondDOM.element, fetchJSON, planningFactory: secondPlanning.factory });
  second.update({}, null);
  await waitFor(() => secondPlanning.mounts[0]?.updates.length === 1);
  assert.equal(requested.at(-1), '2025-09-17');
  assert.equal(secondDOM.nodes.date.value, '2025-09-17');
  assert.equal(secondPlanning.mounts[0].updates[0][0].dispatchSource.date, '2025-09-17');
  second.destroy();
});

test('URL 날짜는 저장된 날짜보다 우선한다', async t => {
  const storage = memoryStorage({ 'meatbox.dispatch.date': '2025-09-17' });
  installBrowserGlobals(t, '?date=2025-09-16', storage);
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const requested = [];
  const fetchJSON = async url => {
    if (url.endsWith('/manifest')) return manifest;
    if (url.endsWith('/regions')) return regions;
    requested.push(url.split('/').at(-1));
    return day(url.split('/').at(-1));
  };
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
  dated.update({}, null);
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  assert.deepEqual(requested, ['2025-09-16']);
  assert.equal(nodes.date.value, '2025-09-16');
  assert.equal(storage.values.get('meatbox.dispatch.date'), '2025-09-16');
  dated.destroy();
});

test('준비되지 않은 저장 날짜는 원본 기본일로 복구한다', async t => {
  const storage = memoryStorage({ 'meatbox.dispatch.date': '2030-01-01' });
  installBrowserGlobals(t, '', storage);
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const requested = [];
  const fetchJSON = async url => {
    if (url.endsWith('/manifest')) return manifest;
    if (url.endsWith('/regions')) return regions;
    requested.push(url.split('/').at(-1));
    return day(url.split('/').at(-1));
  };
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
  dated.update({}, null);
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  assert.deepEqual(requested, [manifest.defaultDate]);
  assert.equal(nodes.date.value, manifest.defaultDate);
  assert.equal(storage.values.get('meatbox.dispatch.date'), manifest.defaultDate);
  dated.destroy();
});

test('세션 저장소 접근이 차단되어도 날짜 자료와 URL 갱신은 동작한다', async t => {
  const storage = memoryStorage({}, true);
  const replaced = installBrowserGlobals(t, '', storage);
  const { element, nodes } = domFixture();
  const planning = planningSpy();
  const fetchJSON = async url => url.endsWith('/manifest') ? manifest : url.endsWith('/regions') ? regions : day(manifest.defaultDate);
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
  dated.update({}, null);
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  assert.equal(nodes.date.value, manifest.defaultDate);
  assert.equal(nodes.planning.hidden, false);
  assert.equal(dated.summary().orders, 1);
  assert.match(replaced.at(-1), /\?date=2025-09-15$/);
  dated.destroy();
});

test('운영 상태가 없으면 CSV 기사 배정과 이전 세션 배정을 복원하거나 명령을 만들지 않는다', async t => {
  const storage = memoryStorage({ 'meatbox.dispatch.assignments.v1:csv-fixture:2025-09-15': JSON.stringify({ O1: 'G2' }) });
  installBrowserGlobals(t, '', storage);
  const source = assignmentDay('2025-09-15');
  const before = structuredClone(source);
  const fetchJSON = async url => url.endsWith('/manifest') ? manifest : url.endsWith('/regions') ? regions : source;
  const { element } = domFixture();
  const planning = planningSpy();
  const dated = mountDatedDispatch({ element, fetchJSON, planningFactory: planning.factory });
  dated.update({ vehicle: { id: 'V1' } }, 'S1');
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  const mounted = planning.mounts[0];
  assert.equal(mounted.options.onSelect, undefined);
  assert.equal(mounted.options.onAssign, undefined);
  assert.deepEqual(mounted.updates[0][0].fleetDeliveries.map(item => item.vehicleId), [null, null, null]);
  assert.equal(mounted.updates[0][0].dispatch.readOnly, true);
  assert.deepEqual(source, before);
  dated.destroy();
});

test('운영자 지도는 미확정 전체 주문을 유지하며 뷰어용 확정 목록을 변경하지 않는다', async t => {
  installBrowserGlobals(t);
  const source = assignmentDay(manifest.defaultDate);
  const operational = {
    sourceData: { date: source.date },
    dispatch: { phase: 'unplanned', readOnly: false },
    dispatchOrders: source.orders.map(item => ({ ...item, vehicleId: null })),
    fleetDeliveries: [], fleetVehicles: [],
  };
  const before = structuredClone(operational);
  const { element, nodes } = domFixture();
  const planning = planningSpy(), workflow = planningSpy();
  const commands = [];
  const dated = mountDatedDispatch({ element, planningFactory: planning.factory, workflowFactory: workflow.factory,
    onDateChange: async () => operational,
    onCommand: (...args) => commands.push(args),
    fetchJSON: async url => url.endsWith('/manifest') ? manifest : url.endsWith('/regions') ? regions : source,
  });
  dated.update(operational, null);
  await waitFor(() => planning.mounts[0]?.updates.length === 1);
  assert.equal(nodes.workflow.hidden, false);
  assert.equal(planning.mounts[0].updates[0][0].fleetDeliveries.length, 3);
  assert.equal(workflow.mounts[0].updates.at(-1)[0], operational);
  assert.deepEqual(operational, before);
  workflow.mounts[0].options.onCommand('calculate_dispatch', { vehicleIds: ['G1'] });
  assert.deepEqual(commands, [['calculate_dispatch', { vehicleIds: ['G1'] }]]);
  dated.destroy();
});
