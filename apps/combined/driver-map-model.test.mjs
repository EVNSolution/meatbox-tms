import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { driverMapModel } from './driver-map-model.mjs';
const data = createRequire(import.meta.url)('../../workspaces/sanghyun-scenario/src/route-data.js');
const deliveries = Array.from({ length: 8 }, (_, index) => ({ id: `S${index + 1}`, sequence: index + 1, status: index < 2 ? 'done' : index === 2 ? 'current' : 'pending' }));

test('배송원 지도는 각 OSRM 구간을 그대로 표시하고 차량도 해당 도로 좌표에 둔다', () => {
  const model = driverMapModel(data, deliveries);
  assert.equal(model.points.length, 8);
  assert.equal(model.road.features.length, 8);
  const leg = data.legs['S2>S3'].coords.map(([lat, lng]) => [lng, lat]);
  assert.deepEqual(model.road.features[2].geometry.coordinates, leg);
  assert.deepEqual(model.vehicle, leg[Math.floor(leg.length * .4)]);
  assert.deepEqual(driverMapModel(data, deliveries, true).vehicle, leg.at(-1));
  assert.equal(driverMapModel(data, deliveries.map(stop => ({ ...stop, status: 'done' }))).vehicle, null);
});
test('누락되거나 손상된 도로 구간을 직선으로 보충하지 않는다', () => {
  const partial = structuredClone(data);
  delete partial.legs['S2>S3'];
  partial.legs['S3>S4'].coords = [[37,127],[38,128]];
  partial.legs['S4>S5'].coords[0] = [NaN, 127];
  const model = driverMapModel(partial, deliveries);
  assert.equal(model.vehicle, null);
  assert.equal(model.road.features.length, 5);
  assert.deepEqual(driverMapModel(data, [{ id: 'V2-S1', status: 'current' }]), { points: [], vehicle: null, road: { type: 'FeatureCollection', features: [] } });
});
test('보류 배송지를 제외하고 편집한 순서의 도로를 사용한다', () => {
  const changed = [deliveries[0], {...deliveries[1], status: 'skipped'}, deliveries[2], deliveries[4], deliveries[3], ...deliveries.slice(5)];
  const model = driverMapModel(data, changed);
  assert.equal(model.points.length, 7);
  assert.deepEqual(model.road.features[1].geometry.coordinates, data.legs['S1>S3'].coords.map(([lat,lng]) => [lng,lat]));
  assert.deepEqual(model.road.features[2].geometry.coordinates, data.legs['S3>S5'].coords.map(([lat,lng]) => [lng,lat]));
});
