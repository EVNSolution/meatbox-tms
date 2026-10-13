import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnverifiedVehicle, locationLabel, plateLabel } from './vehicle-identity.mjs';

test('모든 차량은 명시적으로 등록되지 않으면 미검증으로 본다', () => {
  assert.equal(isUnverifiedVehicle({ source: 'demo-vehicle' }), true);
  assert.equal(isUnverifiedVehicle({}), true, 'source가 아예 없어도 안전하게 미검증으로 본다');
  assert.equal(isUnverifiedVehicle(null), true);
  assert.equal(isUnverifiedVehicle({ source: 'registered' }), false);
});

test('차량번호는 미검증 차량에만 표시를 덧붙이고 번호가 없으면 미등록으로 표기한다', () => {
  assert.equal(plateLabel({ plate: '11가 1234', source: 'demo-vehicle' }), '11가 1234 (미검증)');
  assert.equal(plateLabel({ plate: '11가 1234' }), '11가 1234 (미검증)', 'source가 없어도 기본값은 미검증이다');
  assert.equal(plateLabel({ plate: '11가 1234', source: 'registered' }), '11가 1234');
  assert.equal(plateLabel({ plate: '' }), '차량 미등록');
  assert.equal(plateLabel(null), '차량 미등록');
});

test('위치 문구는 생성기의 예시 표기를 미검증으로 바꾸고 등록된 차량은 그대로 둔다', () => {
  assert.equal(locationLabel({ location: { label: '서울 강서 예시 위치' } }), '서울 강서 미검증 위치');
  assert.equal(locationLabel({ location: { label: '경기 성남 예시 위치' }, source: 'demo-vehicle' }), '경기 성남 미검증 위치');
  assert.equal(locationLabel({ location: { label: '실주소 101' }, source: 'registered' }), '실주소 101');
  assert.equal(locationLabel({ location: {} }), '위치 미등록');
  assert.equal(locationLabel({}), '위치 미등록');
  assert.equal(locationLabel(null), '위치 미등록');
});
