import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDriverMapModel, syncDriverMapInteractions } from './driver-map.mjs';

test('지도가 늦게 생성돼도 먼저 열린 순서 편집의 지도 조작 잠금을 적용한다', () => {
  const actions = [];
  const control = name => ({ enable: () => actions.push(`${name}:enable`), disable: () => actions.push(`${name}:disable`) });
  const map = {
    scrollZoom: control('scroll'),
    boxZoom: control('box'),
    doubleClickZoom: control('double'),
    touchZoomRotate: { ...control('touch'), disableRotation: () => actions.push('rotation:disable') },
  };

  syncDriverMapInteractions(map, true);
  assert.deepEqual(actions, ['scroll:disable', 'box:disable', 'double:disable', 'touch:disable', 'rotation:disable']);
  actions.length = 0;
  syncDriverMapInteractions(map, false);
  assert.deepEqual(actions, ['scroll:enable', 'box:enable', 'double:enable', 'touch:enable', 'rotation:disable']);
});

test('실데이터 지도는 원본 주문 좌표와 데모로 표시된 차량 위치만 사용하며 도로를 만들지 않는다', () => {
  const deliveries = [
    { id: 'ord-1', sequence: 1, status: 'current', coordinates: [127.12, 37.44] },
    { id: 'ord-2', sequence: 2, status: 'pending', coordinates: [127.13, 37.45] },
    { id: 'ord-3', sequence: 3, status: 'skipped', coordinates: [127.14, 37.46] },
    { id: 'ord-4', sequence: 4, status: 'pending', coordinates: null },
  ];
  const model = sourceDriverMapModel(deliveries, { location: { source: 'demo', coordinates: [127.1, 37.5] } });
  assert.deepEqual(model.points.map(point => [point.id, point.coordinate]), [
    ['ord-1', [127.12, 37.44]], ['ord-2', [127.13, 37.45]],
  ]);
  assert.deepEqual(model.vehicle, [127.1, 37.5]);
  assert.deepEqual(model.road.features, []);
  assert.equal(sourceDriverMapModel(deliveries, { location: { source: 'gps', coordinates: [127, 37] } }).vehicle, null);
});
