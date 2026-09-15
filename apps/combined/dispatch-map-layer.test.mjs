import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDispatchMapLayers, stableMarkerVisibility } from './dispatch-map-layer.mjs';

class FakeImage {
  set src(value) { this.url = value; queueMicrotask(() => this.onload?.()); }
  decode() { return Promise.resolve(); }
}
globalThis.Image = FakeImage;

class FakeMap {
  constructor({ loaded = true } = {}) {
    this.loaded = loaded;
    this.listeners = new Map();
    this.sources = new Map();
    this.layers = new Map();
    this.layerOrder = [];
    this.images = new Map();
    this.filters = new Map();
    this.visibility = new Map();
    this.queries = [];
  }
  on(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  off(type, listener) { this.listeners.get(type)?.delete(listener); }
  fire(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  isStyleLoaded() { return this.loaded; }
  hasImage(id) { return this.images.has(id); }
  addImage(id, image) { this.images.set(id, image); }
  removeImage(id) { this.images.delete(id); }
  addSource(id, definition) {
    this.sources.set(id, { definition, data: definition.data, setDataCalls: 0, setData(data) { this.data = data; this.setDataCalls += 1; } });
  }
  getSource(id) { return this.sources.get(id); }
  removeSource(id) { this.sources.delete(id); }
  addLayer(layer) {
    if (layer.filter?.[0] === '==' && layer.filter.slice(1).some(value => !Array.isArray(value))) {
      throw new Error('비교 피연산자는 명시적 expression이어야 합니다.');
    }
    this.layers.set(layer.id, layer);
    this.layerOrder.push(layer.id);
  }
  getLayer(id) { return this.layers.get(id); }
  removeLayer(id) { this.layers.delete(id); this.layerOrder = this.layerOrder.filter(value => value !== id); }
  setFilter(id, filter) { this.filters.set(id, filter); }
  setPaintProperty(id, property, value) { this.layers.get(id).paint[property] = value; }
  setLayoutProperty(id, property, value) { this.visibility.set(`${id}:${property}`, value); }
  queryRenderedFeatures(box, options) { this.lastBox = box; this.lastQueryLayers = options.layers; return this.queries.shift() || []; }
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const points = count => ({
  type: 'FeatureCollection',
  features: Array.from({ length: count }, (_, index) => ({
    type: 'Feature', id: `O${index}`, properties: { orderId: `O${index}`, groupId: `G${index % 3}`, label: `${index + 1}` },
    geometry: { type: 'Point', coordinates: [126.9 + index / 100000, 37.4 + index / 100000] },
  })),
});

test('전체 5000개 주문을 보존하고 줌 14부터 모든 개별 핀을 표시한다', async () => {
  const map = new FakeMap({ loaded: false });
  const data = points(5000);
  const mounted = mountDispatchMapLayers(map);
  mounted.update({ points: data });
  assert.equal(map.sources.size, 0);
  map.fire('style.load');
  await flush();
  assert.deepEqual(map.getSource('dispatch-orders-source').data.features.map(feature => feature.geometry), data.features.map(feature => feature.geometry));
  assert.ok(data.features.every(feature => feature.properties.visibleFromZoom === undefined));
  assert.equal(map.getSource('dispatch-orders-source').data.features.length, 5000);
  assert.equal(map.sources.size, 2);
  assert.ok([...map.sources.values()].every(source => !source.definition.cluster));
  const layer = map.layers.get('dispatch-orders-all');
  assert.equal(layer.source, 'dispatch-orders-source');
  assert.equal(layer.filter, undefined);
  assert.equal(layer.layout['text-field'], undefined);
  assert.equal(layer.layout['icon-allow-overlap'], true);
  assert.equal(layer.layout['icon-ignore-placement'], true);
  assert.deepEqual(layer.paint['icon-opacity'].slice(0, 2), ['step', ['zoom']]);
  for (const output of layer.paint['icon-opacity'].filter((_, index) => index >= 2 && index % 2 === 0)) {
    assert.deepEqual(output.slice(-2), [1, 0]);
  }
  assert.equal(layer.paint['icon-opacity'].at(-2), 14);
  mounted.destroy();
});

test('그룹과 주문 선택은 원본 좌표와 개수를 유지하고 필터만 갱신한다', async () => {
  const map = new FakeMap();
  const data = points(5000);
  const coordinates = data.features.map(feature => feature.geometry.coordinates);
  const mounted = mountDispatchMapLayers(map);
  mounted.update({ points: data, selectedGroupId: 'G1', selectedOrderId: 'O10' });
  await flush();
  const source = map.getSource('dispatch-orders-source');
  assert.equal(source.setDataCalls, 1);
  assert.equal(map.layers.get('dispatch-orders-group').source, 'dispatch-orders-source');
  mounted.update({ points: data, selectedGroupId: 'G2', selectedOrderId: 'O11' });
  assert.equal(source.setDataCalls, 1);
  assert.equal(source.data.features.length, 5000);
  assert.deepEqual(source.data.features.map(feature => feature.geometry.coordinates), coordinates);
  assert.deepEqual(map.filters.get('dispatch-orders-group'), ['==', ['get', 'groupId'], 'G2']);
  assert.deepEqual(map.filters.get('dispatch-order-selected'), ['==', ['get', 'orderId'], 'O11']);
  mounted.destroy();
});

test('겹친 주문을 중복 제거하고 선택 주문과 선택 그룹을 먼저 반환한다', async () => {
  const map = new FakeMap();
  const picked = [];
  const mounted = mountDispatchMapLayers(map, { onPick: (...args) => picked.push(args) });
  mounted.update({ points: points(4), selectedGroupId: 'G1', selectedOrderId: 'O3' });
  await flush();
  map.queries.push([
    { properties: { orderId: 'O0', groupId: 'G0' } },
    { properties: { orderId: 'O1', groupId: 'G1' } },
    { properties: { orderId: 'O3', groupId: 'G0' } },
    { properties: { orderId: 'O1', groupId: 'G1' } },
  ]);
  map.fire('click', { point: { x: 50, y: 80 } });
  assert.deepEqual(picked, [[['O3', 'O1', 'O0']]]);
  assert.deepEqual(map.lastBox, [[38, 68], [62, 92]]);
  mounted.destroy();
});

test('권역은 주문보다 아래에 그리며 직접 선택한 권역만 강조한다', async () => {
  const map = new FakeMap();
  const regions = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { zoneId: 'Z1', label: '권역 1', quality: 'source' }, geometry: { type: 'Polygon', coordinates: [] } }] };
  const mounted = mountDispatchMapLayers(map);
  mounted.update({ points: points(1), regions, selectedZoneIds: ['Z1'], showRegions: true });
  await flush();
  assert.ok(map.layerOrder.indexOf('dispatch-regions-fill') < map.layerOrder.indexOf('dispatch-orders-all'));
  assert.ok(map.layerOrder.indexOf('dispatch-orders-group') < map.layerOrder.indexOf('dispatch-order-selected'));
  assert.equal(map.layers.get('dispatch-orders-group').layout['text-field'], undefined);
  assert.deepEqual(map.layers.get('dispatch-order-selected').layout['text-field'], ['get', 'label']);
  assert.deepEqual(map.filters.get('dispatch-regions-selected'), ['in', ['get', 'zoneId'], ['literal', ['Z1']]]);
  assert.equal(map.visibility.get('dispatch-regions-fill:visibility'), 'visible');
  assert.equal(map.getSource('dispatch-regions-source').setDataCalls, 1);
  mounted.update({ regions, selectedZoneIds: [], showRegions: false });
  assert.equal(map.getSource('dispatch-regions-source').setDataCalls, 1);
  assert.equal(map.visibility.get('dispatch-regions-fill:visibility'), 'none');
  mounted.destroy();
});

test('마커 이미지 실패를 숨기지 않고 오류 콜백으로 전달한다', async () => {
  globalThis.Image = class { set src(_value) { queueMicrotask(() => this.onerror?.()); } };
  const map = new FakeMap();
  const errors = [];
  const mounted = mountDispatchMapLayers(map, { onError: error => errors.push(error) });
  await flush();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /마커 이미지/);
  assert.equal(map.sources.size, 0);
  mounted.destroy();
  globalThis.Image = FakeImage;
});

test('MapLibre가 예외 없이 레이어 오류만 보내도 실패를 알리고 부분 자원을 정리한다', async () => {
  class EventErrorMap extends FakeMap {
    constructor() {
      super();
      this.layers.set('dispatch-orders-group', { id: 'dispatch-orders-group', owner: 'foreign' });
    }
    addLayer(layer) {
      if (layer.id === 'dispatch-orders-group') {
        this.fire('error', { error: new Error('invalid layer filter') });
        return;
      }
      super.addLayer(layer);
    }
  }
  const map = new EventErrorMap();
  const errors = [];
  const mounted = mountDispatchMapLayers(map, { onError: error => errors.push(error) });
  await flush();
  assert.equal(errors[0]?.message, 'invalid layer filter');
  assert.equal(map.layers.size, 1);
  assert.equal(map.getLayer('dispatch-orders-group').owner, 'foreign');
  assert.equal(map.sources.size, 0);
  assert.equal(map.images.size, 0);
  mounted.destroy();
});

test('주문이 없는 클릭만 권역 선택으로 보내고 비동기 준비 중 파괴하면 자원을 남기지 않는다', async () => {
  const map = new FakeMap();
  const picked = [];
  const mounted = mountDispatchMapLayers(map, { onPick: (...args) => picked.push(args) });
  mounted.update({ showRegions: true });
  await flush();
  map.queries.push([], [{ properties: { zoneId: 'Z7' } }]);
  map.fire('click', { point: { x: 20, y: 30 } });
  assert.deepEqual(picked, [[[], { zoneId: 'Z7' }]]);
  mounted.destroy();
  assert.equal(map.layers.size, 0);
  assert.equal(map.sources.size, 0);
  assert.equal(map.images.size, 0);

  let finishDecode;
  globalThis.Image = class extends FakeImage { decode() { return new Promise(resolve => { finishDecode = resolve; }); } };
  const pendingMap = new FakeMap();
  const pending = mountDispatchMapLayers(pendingMap);
  await flush();
  pending.destroy();
  finishDecode();
  await flush();
  assert.equal(pendingMap.layers.size, 0);
  assert.equal(pendingMap.sources.size, 0);
  globalThis.Image = FakeImage;
});


test('흰 원 없이 선택 차량의 모든 주문을 줌 조건보다 우선해 전면 표시한다', async () => {
  const map = new FakeMap();
  const mounted = mountDispatchMapLayers(map);
  await flush();
  assert.ok([...map.layers.values()].every(layer => layer.type !== 'circle'));
  mounted.update({ selectedGroupId: 'G1' });
  assert.deepEqual(map.filters.get('dispatch-orders-group'), ['==', ['get', 'groupId'], 'G1']);
  for (const id of ['dispatch-orders-group', 'dispatch-order-selected']) {
    const layer = map.getLayer(id);
    assert.equal(layer.source, 'dispatch-orders-source');
    assert.equal(layer.layout['icon-allow-overlap'], true);
    assert.equal(layer.layout['icon-ignore-placement'], true);
    assert.equal(layer.minzoom, undefined);
    assert.equal(layer.maxzoom, undefined);
    assert.equal(layer.paint?.['icon-opacity'], undefined);
    assert.ok(map.layerOrder.indexOf(id) > map.layerOrder.indexOf('dispatch-orders-all'));
  }
  mounted.destroy();
});


test('표시 대상은 입력 순서에 무관하며 확대할수록 유지되고 줌 14에 모두 복원된다', () => {
  const data = points(5000);
  const forward = stableMarkerVisibility(data);
  const reverse = stableMarkerVisibility({ ...data, features: [...data.features].reverse() });
  const levels = result => Object.fromEntries(result.features.map(feature => [feature.id, feature.properties.visibleFromZoom]));
  assert.deepEqual(levels(forward), levels(reverse));
  assert.ok(forward.features.filter(feature => feature.properties.visibleFromZoom <= 10).length < 5000);
  let previous = new Set();
  for (let zoom = 5; zoom <= 14; zoom++) {
    const visible = new Set(forward.features.filter(feature => feature.properties.visibleFromZoom <= zoom).map(feature => feature.id));
    assert.ok([...previous].every(id => visible.has(id)));
    previous = visible;
  }
  assert.equal(previous.size, 5000);
  assert.deepEqual(forward.features.map(feature => feature.geometry), data.features.map(feature => feature.geometry));
});

test('동일 위치 주문은 낮은 배율에 하나만 보이고 숨긴 핀은 클릭을 가로채지 않는다', async () => {
  const data = points(3);
  data.features.forEach(feature => { feature.geometry.coordinates = [127, 37.5]; });
  const visible = stableMarkerVisibility(data).features;
  assert.deepEqual(visible.map(feature => feature.properties.visibleFromZoom), [5, 14, 14]);
  const map = new FakeMap();
  let zoom = 13.999;
  map.getZoom = () => zoom;
  const picked = [];
  const mounted = mountDispatchMapLayers(map, { onPick: (...args) => picked.push(args) });
  await flush();
  const feature = { ...visible[1], layer: { id: 'dispatch-orders-all' } };
  map.queries.push([feature]); map.fire('click');
  assert.deepEqual(picked, []);
  zoom = 14;
  map.queries.push([feature]); map.fire('click');
  assert.deepEqual(picked, [[['O1']]]);
  zoom = 8;
  map.queries.push([{ ...feature, layer: { id: 'dispatch-orders-group' } }]); map.fire('click');
  assert.deepEqual(picked.at(-1), [['O1']]);
  mounted.destroy();
});

test('차량 선택 중 일반 핀만 50%로 표시하고 해제하면 즉시 100%로 복원한다', async () => {
  const map = new FakeMap();
  const mounted = mountDispatchMapLayers(map);
  mounted.update({ points: points(5000), selectedGroupId: 'G1' });
  await flush();
  const source = map.getSource('dispatch-orders-source');
  const base = map.getLayer('dispatch-orders-all');
  const outputs = () => base.paint['icon-opacity'].filter((_, index) => index >= 2 && index % 2 === 0);
  assert.ok(outputs().every(output => output.at(-2) === 0.5 && output.at(-1) === 0));
  assert.deepEqual(base.paint['icon-opacity-transition'], { duration: 0, delay: 0 });
  assert.equal(map.getLayer('dispatch-orders-group').paint?.['icon-opacity'], undefined);
  assert.deepEqual(map.filters.get('dispatch-orders-group'), ['==', ['get', 'groupId'], 'G1']);
  mounted.update({ selectedGroupId: null });
  assert.ok(outputs().every(output => output.at(-2) === 1 && output.at(-1) === 0));
  assert.deepEqual(map.filters.get('dispatch-orders-group'), ['==', ['literal', 1], ['literal', 0]]);
  assert.equal(source.setDataCalls, 1);
  assert.equal(source.data.features.length, 5000);
  mounted.destroy();
});

test('전체 핀 보기는 줌 숨김과 클릭 제한을 해제하고 생략 보기로 정확히 돌아간다', async () => {
  const map = new FakeMap();
  map.getZoom = () => 3;
  const data = points(5000), picked = [];
  const mounted = mountDispatchMapLayers(map, { onPick: ids => picked.push(ids) });
  mounted.update({ points: data, showAllPins: true });
  await flush();
  const source = map.getSource('dispatch-orders-source');
  const base = map.getLayer('dispatch-orders-all');
  const hidden = source.data.features.find(feature => feature.properties.visibleFromZoom === 14);
  const hit = { ...hidden, layer: { id: 'dispatch-orders-all' } };
  assert.equal(base.paint['icon-opacity'], 1);
  assert.equal(source.data.features.length, 5000);
  assert.deepEqual(source.data.features.map(feature => feature.geometry), data.features.map(feature => feature.geometry));
  map.queries.push([hit]); map.fire('click');
  assert.deepEqual(picked.at(-1), [hidden.properties.orderId]);
  mounted.update({ selectedGroupId: 'G1' });
  assert.equal(base.paint['icon-opacity'], 0.5);
  assert.deepEqual(map.filters.get('dispatch-orders-group'), ['==', ['get', 'groupId'], 'G1']);
  mounted.update({ showAllPins: false });
  assert.deepEqual(base.paint['icon-opacity'].slice(0, 2), ['step', ['zoom']]);
  assert.equal(base.paint['icon-opacity'][2].at(-2), 0.5);
  const count = picked.length;
  map.queries.push([hit]); map.fire('click');
  assert.equal(picked.length, count);
  mounted.update({ showAllPins: true, selectedGroupId: null });
  assert.equal(base.paint['icon-opacity'], 1);
  assert.equal(source.setDataCalls, 1, '토글로 좌표 자료를 재전송하지 않는다');
  mounted.destroy();
});
