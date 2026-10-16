import test from 'node:test';
import assert from 'node:assert/strict';
import { importInto, normalize, parseImport, problem, remove, rename, toCollection, toZones, vertexCount } from './region-model.ts';
import { createRegionClient, listHtml, mountRegionManager, regionMarkup } from './region-manager.ts';

const ring = (x = 127) => [[x, 37], [x + 1, 37], [x + 1, 38], [x, 38], [x, 37]];
const polygon = (x = 127) => ({ type: 'Polygon', coordinates: [ring(x)] });
const feature = (properties, x = 127) => ({ type: 'Feature', properties, geometry: polygon(x) });
const zone = (zoneId, label = zoneId, x = 127) => ({ zoneId, label, geometry: polygon(x) });

test('a collection, a feature and a bare polygon import; names and codes are read from common properties', () => {
  const many = parseImport(JSON.stringify({ type: 'FeatureCollection', features: [feature({ zoneId: 'A1', label: '강남' }), feature({ name: '서초' }), feature({ id: 7 })] }));
  assert.deepEqual(many.zones.map(item => [item.zoneId, item.label]), [['A1', '강남'], ['서초', '서초'], ['7', '7']]);
  assert.equal(parseImport(JSON.stringify(feature({ zoneId: 'F' }))).zones.length, 1);
  assert.equal(parseImport(JSON.stringify(polygon())).zones.length, 1);
  assert.equal(parseImport(JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[ring()], [ring(130)]] } })).zones.length, 1);
});

test('what is not a closed polygon in longitude and latitude is refused or skipped with a reason', () => {
  assert.match(parseImport('{').error, /GeoJSON 형식/);
  assert.match(parseImport('{"type":"FeatureCollection","features":[]}').error, /비어 있으면/);
  const open = { type: 'Polygon', coordinates: [[[127, 37], [128, 37], [128, 38], [127, 38]]] };
  const mixed = parseImport(JSON.stringify({ type: 'FeatureCollection', features: [feature({ zoneId: 'A' }), { type: 'Feature', properties: { zoneId: 'B' }, geometry: open }, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } }] }));
  assert.equal(mixed.zones.length, 1);
  assert.equal(mixed.skipped, 2);
  assert.match(parseImport(JSON.stringify({ type: 'Feature', properties: {}, geometry: open })).error, /사용할 수 있는 다각형이 없습니다/);
  const far = { type: 'Polygon', coordinates: [[[200, 37], [201, 37], [201, 38], [200, 38], [200, 37]]] };
  assert.match(parseImport(JSON.stringify({ type: 'Feature', properties: {}, geometry: far })).error, /다각형/);
});

test('codes are made valid and unique; merge replaces a same code and replace drops the rest', () => {
  const fixed = normalize([zone('한글'), zone('A'), zone('A'), zone('')], new Set(['R1']));
  assert.deepEqual(fixed.map(item => item.zoneId), ['R2', 'A', 'R3', 'R4']);
  const current = [zone('A', '옛', 127), zone('B', '비', 129)];
  const merged = importInto(current, [zone('A', '새', 131), zone('', '무명', 133)], 'merge');
  assert.deepEqual(merged.map(item => [item.zoneId, item.label]), [['B', '비'], ['A', '새'], ['R1', '무명']]);
  assert.deepEqual(importInto(current, [zone('C')], 'replace').map(item => item.zoneId), ['C']);
});

test('a rename keeps the code, a blank name falls back to the code, and a removal drops the zone', () => {
  const zones = [zone('A', '강남'), zone('B', '서초')];
  assert.equal(rename(zones, 'A', ' 새 이름 ')[0].label, '새 이름');
  assert.equal(rename(zones, 'A', '  ')[0].label, 'A');
  assert.deepEqual(remove(zones, 'A').map(item => item.zoneId), ['B']);
  assert.equal(vertexCount(polygon()), 5);
});

test('a list that cannot be saved says why', () => {
  assert.match(problem([]), /하나도 없습니다/);
  assert.match(problem([zone('A'), zone('A')]), /겹칩니다/);
  assert.equal(problem([zone('A')]), '');
  assert.deepEqual(toZones(toCollection([zone('A', '강남')])).map(item => [item.zoneId, item.label]), [['A', '강남']]);
});

function fixture(fetchImpl) {
  const nodes = new Map();
  const make = () => ({ innerHTML: '', textContent: '', value: '', disabled: false, checked: false, files: undefined, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, make()); return nodes.get(selector); } };
  const manager = mountRegionManager({ element, client: createRegionClient(fetchImpl) });
  const node = selector => nodes.get(selector);
  const click = hook => node('[data-region-manager]').listeners.click({ target: { closest: selector => (selector.includes(hook) ? { dataset: { regionRemove: 'A' } } : null) } });
  return { manager, node, click };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the list loads, an import and a rename wait for the save, and the save sends the whole collection with the revision', async () => {
  const sent = [];
  let state = { revision: 3, custom: false, regions: toCollection([zone('A', '강남')]) };
  const fetchImpl = async (url, init) => {
    if (init.method === 'PUT') { const body = JSON.parse(init.body); sent.push(body); state = { revision: 4, custom: true, regions: body.regions }; return { ok: true, status: 200, json: async () => ({ revision: 4 }) }; }
    return { ok: true, status: 200, json: async () => state };
  };
  assert.match(regionMarkup(), /data-region-import/);
  const { node } = fixture(fetchImpl);
  await flush();
  assert.match(node('[data-region-list]').innerHTML, /강남/);
  assert.match(node('[data-region-status]').textContent, /준비된 권역/);
  assert.equal(node('[data-region-save]').disabled, true);

  node('[data-region-text]').value = JSON.stringify(feature({ zoneId: 'B', label: '서초' }, 130));
  node('[data-region-manager]').listeners.submit({ preventDefault() {} });
  await flush();
  assert.match(node('[data-region-message]').textContent, /1개 권역을 목록에 반영/);
  assert.equal(node('[data-region-save]').disabled, false);
  node('[data-region-manager]').listeners.input({ target: { dataset: { regionLabel: 'A' }, value: '강남구' } });
  node('[data-region-manager]').listeners.click({ target: { closest: selector => (selector.includes('save') ? { dataset: {} } : null) } });
  await flush(); await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].revision, 3);
  assert.deepEqual(sent[0].regions.features.map(item => [item.properties.zoneId, item.properties.label]), [['A', '강남구'], ['B', '서초']]);
  assert.match(node('[data-region-status]').textContent, /운영자가 저장한 권역 2개/);
});

test('a removal can be cancelled before saving, and reverting to the prepared zones asks twice', async () => {
  const sent = [];
  let state = { revision: 5, custom: true, regions: toCollection([zone('A'), zone('B')]) };
  const fetchImpl = async (url, init) => {
    if (init.method === 'PUT') { sent.push(JSON.parse(init.body)); state = { revision: 6, custom: false, regions: toCollection([zone('P')]) }; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => state };
  };
  const { node, click } = fixture(fetchImpl);
  await flush();
  click('[data-region-remove]');
  assert.doesNotMatch(node('[data-region-list]').innerHTML, /data-region-row="A"/);
  assert.match(node('[data-region-status]').textContent, /지운 권역 1개/);
  node('[data-region-manager]').listeners.click({ target: { closest: selector => (selector.includes('discard') ? { dataset: {} } : null) } });
  assert.match(node('[data-region-list]').innerHTML, /data-region-row="A"/);
  const reset = () => node('[data-region-manager]').listeners.click({ target: { closest: selector => (selector.includes('reset') ? { dataset: {} } : null) } });
  reset();
  assert.equal(sent.length, 0);
  assert.match(node('[data-region-reset]').textContent, /정말 되돌립니다/);
  reset();
  await flush(); await flush();
  assert.equal(sent[0].regions, null);
  assert.equal(sent[0].revision, 5);
  assert.match(node('[data-region-message]').textContent, /되돌렸습니다/);
});

test('a lost race reloads and tells; a missing route is worded', async () => {
  let calls = 0;
  const state = { revision: 1, custom: false, regions: toCollection([zone('A'), zone('B')]) };
  const { node, click } = fixture(async (url, init) => {
    calls += 1;
    if (init.method === 'PUT') return { ok: false, status: 409, json: async () => ({ code: 'REGIONS_REVISION_CONFLICT' }) };
    return { ok: true, status: 200, json: async () => state };
  });
  await flush();
  click('[data-region-remove]');
  node('[data-region-manager]').listeners.click({ target: { closest: selector => (selector.includes('save') ? { dataset: {} } : null) } });
  await flush(); await flush(); await flush();
  assert.match(node('[data-region-message]').textContent, /다른 변경이 먼저/);
  assert.equal(calls, 3);
  assert.match(listHtml([], new Set()), /권역이 없습니다/);
  const missing = fixture(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  await flush();
  assert.match(missing.node('[data-region-message]').textContent, /이 환경에는/);
});
