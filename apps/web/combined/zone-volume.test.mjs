import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryBounds, volumeLines, weightText, withZoneVolumes, zoneVolumes } from './zone-volume.mjs';

const regions = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { zoneId: 'Z1', label: '가 권역' }, geometry: { type: 'Polygon', coordinates: [[[127, 37], [127.2, 37], [127.2, 37.1], [127, 37]]] } },
  { type: 'Feature', properties: { zoneId: 'Z2', label: '나 권역' }, geometry: { type: 'Polygon', coordinates: [] } },
  { type: 'Feature', properties: { zoneId: 'Z3', label: '빈 권역' }, geometry: { type: 'Polygon', coordinates: [] } },
] };
const orders = [
  { id: 'O1', name: '정육점 A', address: '서울 1', boxes: 4, zoneIds: ['Z1'] },
  { id: 'O2', name: '정육점 A', address: '서울 1', boxes: 6, zoneIds: ['Z1'] },
  { id: 'O3', name: '식당 B', address: '서울 2', boxes: 11, zoneIds: ['Z1', 'Z2'] },
  { id: 'O4', name: '마트 C', address: '서울 3', boxes: 2, zoneIds: ['Z2', 'Z2'] },
  { id: 'O5', name: '카페 D', address: '서울 4', boxes: 1, zoneIds: [] },
  { id: 'O6', name: '식당 E', address: '서울 5', boxes: 3, zoneIds: ['미등록'] },
];

test('권역별 착지는 같은 이름·주소를 한 곳으로, 박스와 주문은 합산하고 박스 많은 권역을 먼저 둔다', () => {
  const { rows } = zoneVolumes(regions, orders);
  assert.deepEqual(rows.map(row => [row.zoneId, row.destinations, row.boxes, row.orders]), [['Z1', 2, 21, 3], ['Z2', 2, 13, 2]]);
  assert.equal(rows.some(row => row.zoneId === 'Z3'), false, '주문이 없는 권역은 표에 넣지 않는다');
});

test('전체 합계는 여러 권역에 걸친 주문도 한 번만 세고 권역 없는 주문을 따로 센다', () => {
  const { totals, unlocated } = zoneVolumes(regions, orders);
  assert.deepEqual([totals.orders, totals.destinations, totals.boxes], [6, 5, 27]);
  assert.deepEqual([unlocated.orders, unlocated.destinations, unlocated.boxes], [2, 2, 4], '권역이 없거나 경계에 없는 구역 번호는 미지정으로 센다');
});

test('중량은 모든 주문에 숫자 weightKg가 있을 때만 합산하고 아니면 미수신으로 남긴다', () => {
  assert.equal(zoneVolumes(regions, orders).rows[0].weightKg, null);
  const weighed = orders.map(order => ({ ...order, weightKg: order.boxes * 10 }));
  const { rows, totals } = zoneVolumes(regions, weighed);
  assert.equal(rows[0].weightKg, 210);
  assert.equal(totals.weightKg, 270);
  const partial = weighed.map(order => order.id === 'O1' ? { ...order, weightKg: undefined } : order);
  assert.equal(zoneVolumes(regions, partial).rows[0].weightKg, null);
  assert.equal(weightText(null), '미수신');
  assert.equal(weightText(0), '0kg');
  assert.equal(weightText(1234.5), '1,234.5kg');
});

test('박스를 모르는 주문이 있으면 박스 합계를 만들지 않고 알려진 합계 순서 뒤로 보낸다', () => {
  const unknown = orders.map(order => order.id === 'O4' ? { ...order, boxes: undefined } : order);
  const { rows } = zoneVolumes(regions, unknown);
  assert.deepEqual(rows.map(row => [row.zoneId, row.boxes]), [['Z1', 21], ['Z2', null]]);
  assert.equal(zoneVolumes(regions, unknown).totals.boxes, null);
});

test('목록이나 권역이 없어도 0과 빈 표를 돌려주고 입력을 바꾸지 않는다', () => {
  assert.deepEqual(zoneVolumes(null, null).rows, []);
  assert.deepEqual(zoneVolumes(regions, []).totals, { orders: 0, destinations: 0, boxes: 0, weightKg: null });
  const before = structuredClone(orders);
  zoneVolumes(regions, orders);
  assert.deepEqual(orders, before);
});

test('지도 문구는 착지와 박스를 보이고 중량은 값이 있을 때만 덧붙인다', () => {
  assert.deepEqual(volumeLines({ destinations: 12, boxes: 48, weightKg: null }), ['12 Stop', '48 box']);
  assert.deepEqual(volumeLines({ destinations: 1, boxes: 1500, weightKg: 320 }), ['1 Stop', '1,500 box', '320kg']);
  assert.deepEqual(volumeLines({ destinations: 2, boxes: null, weightKg: null }), ['2 Stop', 'box 미확인']);
});

test('권역 경계에는 집계 값만 덧붙이고 원본 경계와 주문 없는 권역은 그대로 둔다', () => {
  const before = structuredClone(regions);
  const { rows } = zoneVolumes(regions, orders);
  const result = withZoneVolumes(regions, rows);
  assert.deepEqual(regions, before);
  assert.deepEqual(result.features[0].properties, { zoneId: 'Z1', label: '가 권역', destinationCount: 2, boxes: 21, weightKg: null });
  assert.deepEqual(result.features[2], regions.features[2]);
  assert.equal(withZoneVolumes(null, rows), null);
});

test('경계 상자는 다각형과 다중 다각형의 모든 점에서 계산하고 점이 없으면 null이다', () => {
  assert.deepEqual(geometryBounds(regions.features[0]), [[127, 37], [127.2, 37.1]]);
  const multi = { geometry: { type: 'MultiPolygon', coordinates: [[[[126, 36], [126.5, 36.5], [126, 36.5]]], [[[128, 38], [128.5, 38.5], [128, 38.5]]]] } };
  assert.deepEqual(geometryBounds(multi), [[126, 36], [128.5, 38.5]]);
  assert.equal(geometryBounds(regions.features[1]), null);
  assert.equal(geometryBounds(null), null);
});

test('주문 중량은 주문 자신의 값이거나 품목 중량의 합이고 하나라도 빠지면 알 수 없다', async () => {
  const { orderWeightKg, weightNote, zoneVolumes } = await import('./zone-volume.mjs');
  assert.equal(orderWeightKg({ weightKg: 5 }), 5);
  assert.equal(orderWeightKg({ items: [{ weightKg: 3.2 }, { weightKg: 1.1 }, { weightKg: 0.7 }] }), 5);
  assert.equal(orderWeightKg({ items: [{ weightKg: 3.2 }, { qty: 1 }] }), null);
  assert.equal(orderWeightKg({ items: [] }), null);
  assert.equal(orderWeightKg({}), null);
  assert.equal(orderWeightKg({ weightKg: -1 }), null);
  const regions = { type: 'FeatureCollection', features: [{ properties: { zoneId: 'Z1', label: '권역 1' } }] };
  const rows = zoneVolumes(regions, [
    { id: 'a', boxes: 1, zoneIds: ['Z1'], items: [{ weightKg: 3.2 }] }, { id: 'b', boxes: 2, zoneIds: ['Z1'], items: [{ weightKg: 1.8 }] },
  ]);
  assert.equal(rows.rows[0].weightKg, 5);
  assert.equal(rows.totals.weightKg, 5);
  const partial = zoneVolumes(regions, [{ id: 'a', boxes: 1, zoneIds: ['Z1'], items: [{ weightKg: 3.2 }] }, { id: 'b', boxes: 2, zoneIds: ['Z1'], items: [{ qty: 1 }] }]);
  assert.equal(partial.rows[0].weightKg, null);
  assert.equal(weightNote([{ id: 'a', items: [{ weightKg: 1 }] }]), '');
  assert.match(weightNote([{ id: 'a' }]), /CSV 원본에는 중량이 없어 중량은 미수신/);
  assert.match(weightNote([{ id: 'a', deliveryType: 'fresh', items: [{ sku: 'x' }] }]), /미트박스 주문의 품목 중량\(items\[\]\.weightKg\)에서 계산합니다/);
  assert.match(weightNote([{ id: 'a', items: [{ weightKg: 1 }] }, { id: 'b' }]), /품목 중량이 없는 주문 1건/);
  assert.equal(weightNote([]), '');
});
