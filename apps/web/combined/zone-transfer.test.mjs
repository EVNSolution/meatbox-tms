import test from 'node:test';
import assert from 'node:assert/strict';
import { driverNamesText, transferZoneOptions, zoneDrivers } from './zone-transfer.mjs';

const deliveries = [
  { id: 'O1', name: 'A', address: '1', assignmentUnitId: 'D1', vehicleId: 'G1', boxes: 4, zoneIds: ['Z1'] },
  { id: 'O2', name: 'A', address: '1', assignmentUnitId: 'D1', vehicleId: 'G1', boxes: 6, zoneIds: ['Z1'] },
  { id: 'O3', name: 'B', address: '2', assignmentUnitId: 'D2', vehicleId: 'G2', boxes: 11, zoneIds: ['Z1', 'Z2'] },
  { id: 'O4', name: 'C', address: '3', assignmentUnitId: 'D3', vehicleId: 'G3', boxes: 5, zoneIds: ['Z2'] },
  { id: 'O5', name: 'D', address: '4', assignmentUnitId: 'D4', vehicleId: null, boxes: 2, zoneIds: ['Z2'] },
  { id: 'O6', name: 'E', address: '5', assignmentUnitId: 'D5', vehicleId: 'G2', boxes: 1, zoneIds: [] },
];
const rows = [{ zoneId: 'Z1', label: '첫 권역' }, { zoneId: 'Z2', label: '둘째 권역' }, { zoneId: 'Z3', label: '셋째 권역' }];

test('권역의 배송원은 그 권역 안의 주문을 가진 차량이며 박스가 많은 순으로 센다', () => {
  const drivers = zoneDrivers(deliveries);
  assert.deepEqual(drivers.get('Z1'), [
    { vehicleId: 'G2', orders: 1, destinations: 1, boxes: 11 },
    { vehicleId: 'G1', orders: 2, destinations: 1, boxes: 10 },
  ]);
  assert.deepEqual(drivers.get('Z2'), [
    { vehicleId: 'G2', orders: 1, destinations: 1, boxes: 11 },
    { vehicleId: 'G3', orders: 1, destinations: 1, boxes: 5 },
  ], '배정되지 않은 주문은 배송원으로 세지 않는다');
  assert.equal(drivers.has('Z3'), false);
  assert.equal(zoneDrivers(null).size, 0);
});

test('박스를 모르는 주문이 있으면 그 배송원의 박스 합계를 만들지 않는다', () => {
  const drivers = zoneDrivers(deliveries.map(item => item.id === 'O2' ? { ...item, boxes: undefined } : item));
  assert.deepEqual(drivers.get('Z1').map(load => [load.vehicleId, load.boxes]), [['G2', 11], ['G1', null]]);
});

test('이관 대상 권역은 자기 권역을 빼고 다른 후보 배송원이 있는 권역만 고른다', () => {
  const drivers = zoneDrivers(deliveries);
  const options = transferZoneOptions(rows, drivers, ['G1', 'G2', 'G3'], { fromZoneId: 'Z1', fromVehicleId: 'G1' });
  assert.deepEqual(options.map(option => [option.zoneId, option.label, option.loads.map(load => load.vehicleId)]), [['Z2', '둘째 권역', ['G2', 'G3']]]);
  const noSelf = transferZoneOptions(rows, drivers, ['G1', 'G2', 'G3'], { fromZoneId: 'Z2', fromVehicleId: 'G3' });
  assert.deepEqual(noSelf.map(option => [option.zoneId, option.loads.map(load => load.vehicleId)]), [['Z1', ['G2', 'G1']]]);
});

test('후보에 없는 배송원과 출발 배송원뿐인 권역은 이관 대상에서 뺀다', () => {
  const drivers = zoneDrivers(deliveries);
  assert.deepEqual(transferZoneOptions(rows, drivers, ['G1'], { fromZoneId: 'Z2', fromVehicleId: 'G3' }).map(option => [option.zoneId, option.loads.map(load => load.vehicleId)]), [['Z1', ['G1']]]);
  assert.deepEqual(transferZoneOptions(rows, drivers, ['G3'], { fromZoneId: 'Z1', fromVehicleId: 'G3' }), []);
  assert.deepEqual(transferZoneOptions(null, drivers, ['G1'], {}), []);
});

test('권역 표의 배송원 문구는 두 명까지 이름을 보이고 나머지는 인원으로 줄이며 배차 전이면 그렇게 밝힌다', () => {
  const nameOf = id => `기사 ${id}`;
  assert.equal(driverNamesText([], nameOf), '배차 전');
  assert.equal(driverNamesText(undefined, nameOf), '배차 전');
  assert.equal(driverNamesText([{ vehicleId: 'G1' }], nameOf), '기사 G1');
  assert.equal(driverNamesText([{ vehicleId: 'G1' }, { vehicleId: 'G2' }], nameOf), '기사 G1, 기사 G2');
  assert.equal(driverNamesText([{ vehicleId: 'G1' }, { vehicleId: 'G2' }, { vehicleId: 'G3' }, { vehicleId: 'G4' }], nameOf), '기사 G1, 기사 G2 외 2명');
});
