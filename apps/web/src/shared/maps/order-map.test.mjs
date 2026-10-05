import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderMap, createOrderMarker, orderMapModel } from './order-map.mjs';
import * as planning from '../../../combined/order-planning.mjs';

function installGlobals(t, values) {
  const previous = new Map(Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

function mapFixture(t, { expanded = false, attribution = true, summary = true } = {}) {
  const calls = { workerUrls: [], observers: [], markers: [], clicks: 0, rotationsDisabled: 0 };
  const attributionElement = {
    classList: { contains: name => name === 'maplibregl-compact-show' && expanded },
    querySelector(selector) {
      assert.equal(selector, 'summary');
      return summary ? { click() { calls.clicks += 1; expanded = false; } } : null;
    },
  };
  const element = {
    querySelector(selector) {
      assert.equal(selector, '.maplibregl-ctrl-attrib');
      return attribution ? attributionElement : null;
    },
  };
  class FakeMap {
    constructor(options) {
      this.options = options;
      this.controls = [];
      this.events = new Map();
      this.touchZoomRotate = { disableRotation() { calls.rotationsDisabled += 1; } };
    }
    addControl(control) { this.controls.push(control); }
    once(event, listener) { this.events.set(event, listener); }
  }
  class FakeAttributionControl {
    constructor(options) { this.options = options; }
  }
  class FakeMarker {
    constructor(options) { this.options = options; this.removed = 0; calls.markers.push(this); }
    setLngLat(coordinates) { this.coordinates = coordinates; return this; }
    addTo(map) { this.map = map; return this; }
    remove() { this.removed += 1; }
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = 0; calls.observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected += 1; }
  }
  installGlobals(t, {
    maplibregl: {
      setWorkerUrl(url) { calls.workerUrls.push(url); },
      Map: FakeMap, AttributionControl: FakeAttributionControl, Marker: FakeMarker,
    },
    MutationObserver: FakeMutationObserver,
    document: {
      createElement(tagName) {
        assert.equal(tagName, 'button');
        return { dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
      },
    },
  });
  return { calls, element, attributionElement, expand() { expanded = true; } };
}

test('order planning retains the exact shared exports for existing regression callers', () => {
  assert.equal(planning.createOrderMap, createOrderMap);
  assert.equal(planning.createOrderMarker, createOrderMarker);
  assert.equal(planning.orderMapModel, orderMapModel);
});

test('the default map retains its worker, style, bounds and interaction settings', t => {
  const { calls, element } = mapFixture(t, { attribution: false });
  const map = createOrderMap(element);
  assert.deepEqual(calls.workerUrls, ['/combined/assets/vendor/maplibre/maplibre-gl-csp-worker.js']);
  assert.deepEqual(map.options, {
    container: element,
    style: '/combined/assets/maps/dsv-korea-v1.json',
    center: [126.995, 37.43], zoom: 10.35,
    maxBounds: [124.5, 33, 132, 39.5],
    attributionControl: false, scrollZoom: true,
    dragRotate: false, touchPitch: false, pitchWithRotate: false, maxPitch: 0,
  });
  assert.equal(calls.rotationsDisabled, 1);
  assert.deepEqual(map.controls.map(control => control.options), [{ compact: true }]);
  assert.equal(calls.observers.length, 0);
  assert.equal(map.events.size, 0);
});

test('expanded attribution collapses immediately and its observer is released on map removal', t => {
  const { calls, element, attributionElement } = mapFixture(t, { expanded: true });
  const map = createOrderMap(element);
  assert.equal(calls.clicks, 1);
  assert.equal(calls.observers.length, 1);
  const [observer] = calls.observers;
  assert.equal(observer.target, attributionElement);
  assert.deepEqual(observer.options, { attributes: true, attributeFilter: ['class'] });
  assert.equal(observer.disconnected, 1);
  map.events.get('remove')();
  assert.equal(observer.disconnected, 2);
});

test('collapsed attribution is observed until expanded and tolerates a missing summary', t => {
  const { calls, element, expand } = mapFixture(t, { summary: false });
  const map = createOrderMap(element);
  const [observer] = calls.observers;
  assert.equal(calls.clicks, 0);
  assert.equal(observer.disconnected, 0);
  expand();
  observer.callback();
  assert.equal(observer.disconnected, 1);
  assert.equal(calls.clicks, 0);
  map.events.get('remove')();
  assert.equal(observer.disconnected, 2);
});

test('a marker retains its identity, numeric sequence, accessible label and removal', t => {
  const { calls } = mapFixture(t);
  const map = {};
  const coordinates = [127.1, 37.5];
  const result = createOrderMarker(map, { id: 'order-1', sequence: 0, name: '매장 <가>', boxes: 1200 }, coordinates);
  assert.equal(result.element.type, 'button');
  assert.equal(result.element.className, 'order-map-marker');
  assert.deepEqual(result.element.dataset, { orderMarker: 'order-1', orderLabel: '0' });
  assert.equal(result.element.attributes['aria-label'], '매장 <가> 1,200박스 선택');
  const [marker] = calls.markers;
  assert.equal(marker.options.element, result.element);
  assert.equal(marker.options.anchor, 'bottom');
  assert.equal(marker.coordinates, coordinates);
  assert.equal(marker.map, map);
  result.remove();
  assert.equal(marker.removed, 1);
});

test('marker labels preserve the name and unknown-data fallbacks', t => {
  mapFixture(t);
  const named = createOrderMarker({}, { id: 'named', sequence: Infinity, name: '매장', boxes: 0 }, [127, 37]);
  assert.equal(named.element.dataset.orderLabel, '매장');
  assert.equal(named.element.attributes['aria-label'], '매장 0박스 선택');
  for (const boxes of [undefined, null, -1, Infinity, '3']) {
    const unknown = createOrderMarker({}, { id: 'unknown', boxes }, [127, 37]);
    assert.equal(unknown.element.dataset.orderLabel, '배송지 미등록');
    assert.equal(unknown.element.attributes['aria-label'], '배송지 미등록 미확인 선택');
  }
});

test('the map model retains valid coordinates, delivery identity and unknown counts', () => {
  const deliveries = [{ id: 'valid' }, { id: 'edge' }, { id: 'invalid' }, { id: 'missing' }];
  const routeData = { points: [
    { id: 'valid', lng: 127, lat: 37 },
    { id: 'valid', lng: 127.1, lat: 37.1 },
    { id: 'edge', lng: -180, lat: 90 },
    { id: 'invalid', lng: 181, lat: 37 },
    { id: 'invalid', lng: 127, lat: NaN },
    { id: 1, lng: 127, lat: 37 },
  ] };
  const model = orderMapModel(deliveries, routeData);
  assert.deepEqual(model, { mapped: [
    { delivery: deliveries[0], coordinates: [127.1, 37.1] },
    { delivery: deliveries[1], coordinates: [-180, 90] },
  ], unknownCount: 2 });
  assert.equal(model.mapped[0].delivery, deliveries[0]);
  assert.deepEqual(orderMapModel(deliveries, null), { mapped: [], unknownCount: 4 });
  assert.deepEqual(orderMapModel(undefined, undefined), { mapped: [], unknownCount: 0 });
});
