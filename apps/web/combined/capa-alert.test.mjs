import test from 'node:test';
import assert from 'node:assert/strict';
import { capaAlertMarkup, mountCapaAlert, overListHtml } from './capa-alert.ts';

const regions = { type: 'FeatureCollection', features: [{ properties: { zoneId: 'Z1', label: '강남' } }] };
const order = (id, vehicleId) => ({ id, vehicleId, name: id, address: id, boxes: 10, zoneIds: ['Z1'], weightKg: 5 });
const inputs = (capa) => ({ assignments: new Map([['V1', 'kim']]), profiles: new Map([['kim', { username: 'kim', capa: { stops: null, boxes: null, weightKg: null, ...capa } }]]) });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(load) {
  const nodes = new Map();
  const make = () => ({ hidden: true, textContent: '', innerHTML: '', open: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, make()); return nodes.get(selector); } };
  const focused = [];
  const alert = mountCapaAlert({ element, sources: { load }, onFocus: id => focused.push(id) });
  const node = selector => nodes.get(selector);
  const day = (phase, boxes = 10) => ({ date: '2026-11-02', phase, vehicles: [{ id: 'V1', driver: '김기사' }], deliveries: [order('a', 'V1'), { ...order('b', 'V1'), boxes }], regions });
  return { alert, node, focused, day };
}

test('the markup has the hooks the mount uses', () => {
  for (const hook of ['data-capa-alert', 'data-capa-text', 'data-capa-open', 'data-capa-dialog', 'data-capa-list', 'data-capa-close']) assert.match(capaAlertMarkup(), new RegExp(hook));
});

test('nothing shows before the dispatch is confirmed', async () => {
  const { alert, node, day } = fixture(async () => inputs({ boxes: 1 }));
  alert.update(day('draft'));
  await flush();
  assert.equal(node('[data-capa-alert]').hidden, true);
});

test('a confirmed dispatch over a driver Capa shows the line and a click on a row hands the vehicle to the map', async () => {
  const { alert, node, focused, day } = fixture(async () => inputs({ boxes: 15 }));
  alert.update(day('published'));
  await flush();
  assert.equal(node('[data-capa-alert]').hidden, false);
  assert.match(node('[data-capa-text]').textContent, /Capa 초과 배송원 1명/);
  assert.match(node('[data-capa-list]').innerHTML, /박스 20박스 \/ 최대 15박스/);
  assert.equal(node('[data-capa-dialog]').open, false, 'a page that opens already confirmed does not pop up');
  node('[data-capa-dialog]').listeners.click({ target: { closest: selector => (selector.includes('focus') ? { dataset: { capaFocus: 'V1' } } : null) } });
  assert.deepEqual(focused, ['V1']);
});

test('the popup opens by itself when this session publishes and a vehicle is over', async () => {
  const { alert, node, day } = fixture(async () => inputs({ boxes: 15 }));
  alert.update(day('draft'));
  alert.update(day('published'));
  await flush();
  assert.equal(node('[data-capa-dialog]').open, true);
});

test('within the Capa nothing is said, and a missing driver master is silent', async () => {
  const within = fixture(async () => inputs({ boxes: 100 }));
  within.alert.update(within.day('published'));
  await flush();
  assert.equal(within.node('[data-capa-alert]').hidden, true);
  const silent = fixture(async () => { throw new Error('404'); });
  silent.alert.update(silent.day('published'));
  await flush();
  assert.equal(silent.node('[data-capa-alert]').hidden, true);
});

test('vehicles without Capa are counted in the note instead of passing', async () => {
  const { alert, node, day } = fixture(async () => inputs({}));
  alert.update(day('published'));
  await flush();
  assert.match(node('[data-capa-text]').textContent, /Capa를 설정하지 않은 차량 1대/);
  assert.equal(overListHtml({ overs: [], unset: [], checked: 0, weightUnchecked: false }), '');
});
