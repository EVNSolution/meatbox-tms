import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTemperaturePanel, temperaturePanelMarkup } from './temperature-panel.ts';
import { TemperatureError } from './temperature-client.ts';

class FakeNode {
  innerHTML = ''; textContent = ''; hidden = false; listeners = {};
  addEventListener(type, listener) { this.listeners[type] = listener; }
  getBoundingClientRect() { return { left: 0, width: 640 }; }
  querySelector(selector) { return selector === 'svg' ? this.svg : null; }
  cursor = null;
  svg = { querySelector: () => this.cursor };
}
const DATE = '2026-11-02';
const history = (measurements = [], extra = {}) => ({ vehicleId: 'V1', from: 'a', to: 'b', measurements, truncated: false, ...extra });
const reading = (extra = {}) => ({ celsius: -18.4, measuredAt: '2026-11-02T09:12:30+09:00', stale: false, outOfRange: false, ...extra });
const measurement = (minute, celsius = -18.2) => ({ sensorId: 'S1', measuredAt: new Date(Date.parse(`${DATE}T00:00:00+09:00`) + minute * 60_000).toISOString(), celsius, min: celsius - 0.1, max: celsius + 0.1, count: 6 });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(client, extra = {}) {
  const nodes = new Map();
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new FakeNode()); return nodes.get(selector); } };
  const state = { active: true };
  const panel = mountTemperaturePanel({ element, client, isActive: () => state.active, pollMs: 5, now: () => Date.parse(`${DATE}T06:00:00Z`), ...extra });
  const node = selector => nodes.get(selector);
  const vehicle = { id: 'V1', driver: '김기사' };
  const show = (over = {}) => panel.update({ date: DATE, today: DATE, vehicle, reading: reading(), ...over });
  return { panel, node, state, show };
}

test('the markup has the places the panel fills', () => {
  const html = temperaturePanelMarkup();
  for (const hook of ['data-temp-now', 'data-temp-chart', 'data-temp-tip', 'data-temp-stats', 'data-temp-note']) assert.match(html, new RegExp(hook));
});

test('today shows the current value in words and the graph of the day with the allowed range from the latest list', async () => {
  const calls = [];
  const client = {
    history: async (id, date) => { calls.push(['history', id, date]); return history([measurement(0), measurement(1), measurement(2)]); },
    latest: async () => [{ vehicleId: 'V1', sensorId: 'S1', range: { min: null, max: -18 } }, { vehicleId: 'V2', sensorId: 'S9', range: { min: 0, max: 5 } }],
  };
  const { panel, node, show } = fixture(client, { pollMs: 60_000 });
  show();
  assert.match(node('[data-temp-now]').innerHTML, /badge green">정상<\/span> <strong>-18\.4°C<\/strong>.*09:12/);
  await flush();
  assert.deepEqual(calls, [['history', 'V1', DATE]]);
  assert.match(node('[data-temp-chart]').innerHTML, /<svg/);
  assert.match(node('[data-temp-chart]').innerHTML, /상한 -18\.0°C/);
  assert.doesNotMatch(node('[data-temp-chart]').innerHTML, /하한 0\.0°C/, '다른 차량의 범위는 그리지 않는다');
  assert.match(node('[data-temp-stats]').textContent, /^최저 -18\.3°C/);
  assert.match(node('[data-temp-note]').textContent, /5분 넘게 받지 못한 구간은 이어 그리지 않고/);
  assert.match(node('[data-temp-note]').textContent, /60초마다/);
  panel.destroy();
});

test('a past date says that the current value is only for today and does not poll', async () => {
  let calls = 0;
  const client = { history: async () => { calls += 1; return history([]); }, latest: async () => [] };
  const { panel, node, show } = fixture(client);
  show({ date: '2026-11-01', reading: null });
  await flush();
  assert.match(node('[data-temp-now]').innerHTML, /현재값은 오늘 날짜에만/);
  assert.match(node('[data-temp-chart]').innerHTML, /이 날짜에 수신된 온도가 없습니다/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  panel.destroy();
});

test('a vehicle that sent nothing today says so, and out of range shows in words', async () => {
  const client = { history: async () => history([]), latest: async () => [] };
  const { panel, node, show } = fixture(client, { pollMs: 60_000 });
  show({ reading: null });
  assert.match(node('[data-temp-now]').innerHTML, /정보 없음.*오늘 이 차량이 보낸 온도가 없습니다/);
  show({ reading: reading({ celsius: -9, outOfRange: true }) });
  assert.match(node('[data-temp-now]').innerHTML, /badge red">범위 밖<\/span> <strong>-9\.0°C/);
  panel.destroy();
});

test('the history is read when the tab opens or the choice changes, not on every state, and is refreshed while the tab is open', async () => {
  let calls = 0;
  const client = { history: async () => { calls += 1; return history([measurement(0), measurement(1)]); }, latest: async () => [] };
  const { panel, state, show } = fixture(client);
  state.active = false;
  show();
  await flush();
  assert.equal(calls, 0, '탭이 닫혀 있으면 읽지 않는다');
  state.active = true;
  show();
  await flush();
  assert.equal(calls, 1);
  show(); show();
  await flush();
  assert.equal(calls, 1, '같은 선택의 상태 갱신은 다시 읽지 않는다');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(calls >= 2, '오늘 값은 주기적으로 다시 읽는다');
  state.active = false;
  show();
  const stopped = calls;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, stopped, '탭을 닫으면 멈춘다');
  panel.destroy();
});

test('an answer for a vehicle that is no longer selected is dropped', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const client = { history: async id => (id === 'V1' ? (await slow, history([measurement(0), measurement(1)])) : history([measurement(0, -10), measurement(1, -10)])), latest: async () => [] };
  const { panel, node, show } = fixture(client, { pollMs: 60_000 });
  show();
  show({ vehicle: { id: 'V2', driver: '이기사' } });
  await flush();
  release();
  await flush();
  assert.match(node('[data-temp-stats]').textContent, /-10\.1°C|-10\.0°C/);
  panel.destroy();
});

test('a failure shows its reason and a retry instead of an empty graph, and an unavailable module is not asked again', async () => {
  let calls = 0;
  const client = { history: async () => { calls += 1; throw new TemperatureError('온도 수신이 설정되지 않은 환경입니다.', 404); }, latest: async () => [] };
  const { panel, node, show } = fixture(client);
  show();
  await flush();
  assert.match(node('[data-temp-chart]').innerHTML, /role="alert">온도 수신이 설정되지 않은 환경입니다\./);
  assert.match(node('[data-temp-chart]').innerHTML, /data-temp-retry/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  node('[data-temp-chart]').listeners.click({ target: { closest: selector => selector === '[data-temp-retry]' ? {} : null } });
  await flush();
  assert.equal(calls, 2);
  panel.destroy();
});

test('the key and the pointer read a value off the graph', async () => {
  const client = { history: async () => history([measurement(0, -18), measurement(60, -17), measurement(120, -16)]), latest: async () => [] };
  const { panel, node, show } = fixture(client, { pollMs: 60_000 });
  show();
  await flush();
  const cursor = { attributes: {}, hidden: true, setAttribute(name, value) { this.attributes[name] = value; } };
  node('[data-temp-chart]').cursor = cursor;
  let prevented = false;
  node('[data-temp-chart]').listeners.keydown({ key: 'ArrowLeft', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(node('[data-temp-tip]').textContent, /-17\.0°C \(센서 S1\)/);
  assert.equal(cursor.hidden, false);
  node('[data-temp-chart]').listeners.pointermove({ clientX: 0 });
  assert.match(node('[data-temp-tip]').textContent, /-18\.0°C/);
  panel.clear();
  assert.equal(node('[data-temp-chart]').innerHTML, '');
  panel.destroy();
});
