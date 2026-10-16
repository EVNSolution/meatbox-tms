import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTemperatureOverview, overviewTable } from './temperature-overview.ts';
import { overviewRows } from './temperature-model.ts';
import { TemperatureError } from './temperature-client.ts';

class FakeNode {
  innerHTML = ''; open = false; disabled = false; listeners = {};
  addEventListener(type, listener) { this.listeners[type] = listener; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
}
const latest = (vehicleId, extra = {}) => ({
  vehicleId, sensorId: 'S1', celsius: -18.1, measuredAt: '2026-11-02T09:12:30+09:00', receivedAt: '2026-11-02T09:12:31+09:00',
  ageSeconds: 29, stale: false, outOfRange: false, range: { min: null, max: -18 }, compartment: null, ...extra,
});
function fixture(client, extra = {}) {
  const nodes = new Map();
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new FakeNode()); return nodes.get(selector); } };
  const picked = [];
  const overview = mountTemperatureOverview({ element, client, onSelectVehicle: id => picked.push(id), pollMs: 5, ...extra });
  const node = selector => nodes.get(selector);
  return { overview, node, picked, open: () => node('[data-control-temperature]').listeners.click() };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the table names the vehicle, the value, the state in words, the last receipt and the range', () => {
  const html = overviewTable(overviewRows([{ id: 'V1', driver: '김기사' }], [latest('V1', { outOfRange: true, celsius: -9 })]));
  assert.match(html, /김기사/);
  assert.match(html, /-9\.0°C/);
  assert.match(html, /<span class="badge red">범위 밖<\/span>/);
  assert.match(html, /09:12/);
  assert.match(html, /-18\.0°C 이하/);
});

test('opening the dialog loads the list, shows the ones to look at first and picking a vehicle closes it', async () => {
  const fixtureClient = { latest: async () => [latest('V1'), latest('V2', { outOfRange: true })] };
  const { overview, node, picked, open } = fixture(fixtureClient, { pollMs: 60_000 });
  overview.update([{ id: 'V1', driver: '김' }, { id: 'V2', driver: '이' }]);
  open();
  assert.equal(node('[data-temp-dialog]').open, true);
  await flush();
  const html = node('[data-temp-data]').innerHTML;
  assert.ok(html.indexOf('이') < html.indexOf('김'), '범위 밖 차량이 위에 온다');
  node('[data-temp-data]').listeners.click({ target: { closest: selector => selector === '[data-temp-vehicle]' ? { dataset: { tempVehicle: 'V2' } } : null } });
  assert.deepEqual(picked, ['V2']);
  assert.equal(node('[data-temp-dialog]').open, false);
  assert.equal(node('[data-control-temperature]').focused, true);
  overview.destroy();
});

test('a failure replaces the list with its reason and a retry, and an unavailable module is not polled again', async () => {
  let calls = 0;
  const client = { latest: async () => { calls += 1; throw new TemperatureError('온도 수신이 설정되지 않은 환경입니다.', 404); } };
  const { overview, node, open } = fixture(client);
  open();
  await flush(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(node('[data-temp-data]').innerHTML, /role="alert"/);
  assert.match(node('[data-temp-data]').innerHTML, /설정되지 않은/);
  assert.match(node('[data-temp-data]').innerHTML, /다시 불러오기/);
  assert.equal(calls, 1);
  overview.destroy();
});

test('an older list is not shown as current after a later failure, and a closed dialog stops asking', async () => {
  let fail = false; let calls = 0;
  const client = { latest: async () => { calls += 1; if (fail) throw new Error('끊김'); return [latest('V1')]; } };
  const { overview, node, open } = fixture(client);
  open();
  await flush();
  assert.match(node('[data-temp-data]').innerHTML, /<table/);
  fail = true;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.doesNotMatch(node('[data-temp-data]').innerHTML, /<table/);
  assert.match(node('[data-temp-data]').innerHTML, /끊김/);
  node('[data-temp-dialog]').close();
  const settled = calls;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, settled);
  overview.destroy();
});

test('the button is disabled while there is no control data', () => {
  const { overview, node } = fixture({ latest: async () => [] });
  overview.setEnabled(false);
  assert.equal(node('[data-control-temperature]').disabled, true);
  overview.setEnabled(true);
  assert.equal(node('[data-control-temperature]').disabled, false);
});
