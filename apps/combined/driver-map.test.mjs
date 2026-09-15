import test from 'node:test';
import assert from 'node:assert/strict';
import { syncDriverMapInteractions } from './driver-map.mjs';

test('지도가 늦게 생성돼도 먼저 열린 순서 편집의 지도 조작 잠금을 적용한다', () => {
  const actions = [];
  const control = name => ({ enable: () => actions.push(`${name}:enable`), disable: () => actions.push(`${name}:disable`) });
  const map = {
    scrollZoom: control('scroll'),
    boxZoom: control('box'),
    doubleClickZoom: control('double'),
    touchZoomRotate: { ...control('touch'), disableRotation: () => actions.push('rotation:disable') },
  };
  const wheelZoom = { setEnabled: value => actions.push(`modifier:${value}`) };

  syncDriverMapInteractions(map, wheelZoom, true);
  assert.deepEqual(actions, ['scroll:disable', 'box:disable', 'double:disable', 'touch:disable', 'modifier:false', 'rotation:disable']);
  actions.length = 0;
  syncDriverMapInteractions(map, wheelZoom, false);
  assert.deepEqual(actions, ['scroll:enable', 'box:enable', 'double:enable', 'touch:enable', 'modifier:true', 'rotation:disable']);
});
