import test from 'node:test';
import assert from 'node:assert/strict';
import routeData from '../../workspaces/sanghyun-scenario/src/route-data.js';
import { customerDemoRoad } from './customer-demo-route.mjs';

test('예시 차량부터 매장까지 저장된 OSRM 도로 좌표만 사용한다', () => {
  for (const point of routeData.points.filter(point => point.id !== 'MFC')) {
    const source = routeData.legs[`MFC>${point.id}`].coords.map(([lat, lng]) => [lng, lat]);
    const road = customerDemoRoad(routeData, point.id);
    assert.ok(road.length > 2 && road.length < source.length);
    assert.deepEqual(road, source.slice(source.length - road.length));
    assert.deepEqual(customerDemoRoad(routeData, point.id), road);
  }
});

test('없는 경로나 잘못된 좌표를 직선으로 대체하지 않는다', () => {
  assert.deepEqual(customerDemoRoad(routeData, 'unknown'), []);
  assert.deepEqual(customerDemoRoad(null, 'S3'), []);
  for (const coords of [null, [[37, 127], [38, 128]], [[37, 127], [NaN, 127], [38, 128]], [[37, 127], [91, 127], [38, 128]]]) {
    assert.deepEqual(customerDemoRoad({ legs: { 'MFC>S3': { coords } } }, 'S3'), []);
  }
});
