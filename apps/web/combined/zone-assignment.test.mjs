import test from 'node:test';
import assert from 'node:assert/strict';
import { withDerivedZones, zoneNotes, zonesAt } from './zone-assignment.ts';

const square = (id, x, y, size = 1) => ({ type: 'Feature', properties: { zoneId: id }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] } });
const holed = { type: 'Feature', properties: { zoneId: 'H' }, geometry: { type: 'Polygon', coordinates: [[[10, 10], [14, 10], [14, 14], [10, 14], [10, 10]], [[11, 11], [13, 11], [13, 13], [11, 13], [11, 11]]] } };
const multi = { type: 'Feature', properties: { zoneId: 'M' }, geometry: { type: 'MultiPolygon', coordinates: [[[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]], [[[30, 30], [31, 30], [31, 31], [30, 31], [30, 30]]]] } };
const regions = { type: 'FeatureCollection', features: [square('A', 0, 0), square('B', 0.5, 0.5), holed, multi, { type: 'Feature', properties: { zoneId: 'N' }, geometry: null }] };

test('a point is in every zone that contains it and in none of the others', () => {
  assert.deepEqual(zonesAt(regions, 0.25, 0.25), ['A']);
  assert.deepEqual(zonesAt(regions, 0.75, 0.75), ['A', 'B']);
  assert.deepEqual(zonesAt(regions, 5, 5), []);
});

test('a hole is outside the zone and a multi-polygon holds every part', () => {
  assert.deepEqual(zonesAt(regions, 10.5, 10.5), ['H']);
  assert.deepEqual(zonesAt(regions, 12, 12), []);
  assert.deepEqual(zonesAt(regions, 30.5, 30.5), ['M']);
  assert.deepEqual(zonesAt(regions, 25, 25), []);
});

test('orders without zones are placed from their coordinates, others are left alone', () => {
  const orders = [
    { id: 'api', coordinates: [0.25, 0.25], zoneIds: [] },
    { id: 'csv', coordinates: [0.25, 0.25], zoneIds: ['PREPARED'] },
    { id: 'nowhere', coordinates: null, zoneIds: [] },
    { id: 'outside', coordinates: [50, 50], zoneIds: [] },
  ];
  const result = withDerivedZones(regions, orders);
  assert.deepEqual(result.map(order => order.zoneIds), [['A'], ['PREPARED'], [], []]);
  assert.equal(result[0].zonesDerived, true);
  assert.equal(result[1], orders[1], '준비된 권역은 그대로');
  assert.deepEqual(orders[0].zoneIds, [], '원본 배열은 바꾸지 않는다');
});

test('a day whose orders already have zones is returned as the same array, and the answer is remembered', () => {
  const prepared = [{ id: 'x', coordinates: [0.25, 0.25], zoneIds: ['A'] }];
  assert.equal(withDerivedZones(regions, prepared), prepared);
  const api = [{ id: 'y', coordinates: [0.25, 0.25], zoneIds: [] }];
  assert.equal(withDerivedZones(regions, api), withDerivedZones(regions, api));
  assert.equal(withDerivedZones(null, api), api);
  assert.equal(withDerivedZones(regions, undefined), undefined);
});

test('the notes say how many zones were derived and that orders without coordinates could not be placed', () => {
  const orders = withDerivedZones(regions, [
    { id: 'a', deliveryType: 'fresh', coordinates: [0.25, 0.25], zoneIds: [] },
    { id: 'b', deliveryType: 'parcel', coordinates: null, zoneIds: [] },
  ]);
  assert.deepEqual(zoneNotes(orders), ['권역 1건은 좌표로 화면에서 계산했습니다.', '좌표가 없는 주문 1건은 권역에 넣지 못했습니다. 미트박스가 주소 좌표(lat/lng)를 보내야 합니다.']);
  assert.deepEqual(zoneNotes([{ id: 'c', coordinates: null, zoneIds: [] }]), [], 'CSV 날짜는 좌표 없음을 미트박스 탓으로 말하지 않는다');
  assert.deepEqual(zoneNotes(undefined), []);
});
