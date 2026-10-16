import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNotes, mountDriverNotes, notesHtml, notesMarkup, parseNotes } from './driver-notes.ts';

const item = (over = {}) => ({ vehicleId: 'G1', driver: '김기사', stopId: 'O1', name: '가게', address: '서울', result: 'failed', reasonCode: 'ABSENT', note: '<b>부재</b>', at: '2026-11-02T10:00:00+09:00', ...over });
const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(fetchImpl) {
  const nodes = new Map();
  const make = () => ({ innerHTML: '', textContent: '', open: false, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, make()); return nodes.get(selector); } };
  const panel = mountDriverNotes({ element, fetchImpl });
  return { panel, node: selector => nodes.get(selector) };
}

test('the markup has the hooks the mount fills', () => {
  for (const hook of ['data-driver-notes', 'data-driver-notes-body', 'data-driver-notes-count']) assert.match(notesMarkup(), new RegExp(hook));
});

test('a note is shown escaped with its stop, result, reason, driver and time', () => {
  const html = notesHtml(parseNotes({ items: [item()] }));
  assert.match(html, /&lt;b&gt;부재&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /미배송 · 수령인 부재/);
  assert.match(html, /김기사 · 서울 · 10:00/);
  assert.match(notesHtml([]), /특이사항이 없습니다/);
});

test('a malformed response is rejected and a missing route is worded', async () => {
  assert.throws(() => parseNotes({}), /확인할 수 없습니다/);
  await assert.rejects(fetchNotes('2026-11-02', respond(404, {})), /이 환경에는/);
  await assert.rejects(fetchNotes('2026-11-02', respond(403, {})), /운영자 계정/);
});

test('the list loads only while opened and follows the date', async () => {
  const urls = [];
  const { panel, node } = fixture(async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ items: [item()] }) }; });
  panel.update({ date: '2026-11-02' });
  await flush();
  assert.equal(urls.length, 0);
  const box = node('[data-driver-notes]');
  box.open = true;
  box.listeners.toggle();
  await flush();
  assert.deepEqual(urls, ['/api/ops/driver-notes?date=2026-11-02']);
  assert.equal(node('[data-driver-notes-count]').textContent, '1건');
  panel.update({ date: '2026-11-03' });
  await flush();
  assert.equal(urls.length, 2);
  assert.match(urls[1], /2026-11-03/);
});

test('a failed load shows the reason instead of an empty list', async () => {
  const { panel, node } = fixture(respond(503, {}));
  panel.update({ date: '2026-11-02' });
  node('[data-driver-notes]').open = true;
  node('[data-driver-notes]').listeners.toggle();
  await flush();
  assert.match(node('[data-driver-notes-body]').innerHTML, /사용할 수 없습니다/);
});
