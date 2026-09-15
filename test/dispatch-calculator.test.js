'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateDispatch } = require('../lib/dispatch-calculator.js');

const vehicle = id => ({ id, location: { coordinates: [0, 0], source: 'demo' } });
const order = (id, groupId, boxes, coordinates) => ({ id, groupId, boxes, coordinates });
const unit = (id, ...orderIds) => ({ id, orderIds });

function fixture() {
  return {
    orders: [
      order('W1', 'V1', 6, [126.8, 37.5]), order('W2', 'V1', 4, [126.81, 37.5]),
      order('E1', 'V2', 5, [127.2, 37.5]), order('E2', 'V2', 5, [127.21, 37.5]),
    ],
    vehicles: [vehicle('V1'), vehicle('V2'), vehicle('V3')],
    vehicleIds: ['V1', 'V2'],
    units: [unit('UW1', 'W1'), unit('UW2', 'W2'), unit('UE1', 'E1'), unit('UE2', 'E2')],
  };
}

test('모든 주문을 선택한 차량에 보존하고 같은 배송지 묶음을 나누지 않는다', () => {
  const input = fixture();
  input.orders.push(order('W1-B', 'V2', 3, [126.8, 37.5]));
  input.units[0].orderIds.push('W1-B');
  const before = structuredClone(input);
  const result = calculateDispatch(input);

  assert.deepEqual(Object.keys(result).sort(), input.orders.map(item => item.id).sort());
  assert.equal(result.W1, result['W1-B']);
  assert.equal(Object.values(result).every(id => input.vehicleIds.includes(id)), true);
  assert.deepEqual(input, before);
});

test('가까운 배송지를 함께 두고 원본 주문 중심에 맞는 배송원으로 연결한다', () => {
  const input = fixture();
  const result = calculateDispatch(input);

  assert.equal(result.W1, result.W2);
  assert.equal(result.E1, result.E2);
  assert.notEqual(result.W1, result.E1);
  assert.equal(result.W1, 'V1');
  assert.equal(result.E1, 'V2');
});

test('지리적 묶음 안에서 박스 물량을 균형 있게 나누며 결과가 결정적이다', () => {
  const input = fixture();
  const first = calculateDispatch(input);
  const second = calculateDispatch(structuredClone(input));
  const loads = Object.fromEntries(input.vehicleIds.map(id => [id, 0]));
  for (const item of input.orders) loads[first[item.id]] += item.boxes;

  assert.deepEqual(first, second);
  assert.deepEqual(loads, { V1: 10, V2: 10 });
});

test('좌표 없는 묶음은 물량만으로 배분하고 큰 묶음은 그대로 유지한다', () => {
  const input = fixture();
  input.vehicleIds.push('V3');
  input.orders.push(order('M1', 'V1', 100, null), order('M2', 'V1', 2, undefined));
  input.units.push(unit('UM1', 'M1'), unit('UM2', 'M2'));
  const withDemoLocations = calculateDispatch(input);
  const withoutLocations = calculateDispatch({ ...input, vehicles: input.vehicles.map(({ id }) => ({ id })) });

  assert.deepEqual(withDemoLocations, withoutLocations);
  assert.equal(typeof withDemoLocations.M1, 'string');
  assert.equal(Object.keys(withDemoLocations).length, input.orders.length);
});

test('배송지보다 차량이 많으면 빈 차량을 허용한다', () => {
  const input = {
    orders: [order('O1', 'V2', 9, [127, 37.5])],
    vehicles: [vehicle('V1'), vehicle('V2'), vehicle('V3')],
    vehicleIds: ['V1', 'V2', 'V3'],
    units: [unit('U1', 'O1')],
  };
  const result = calculateDispatch(input);
  assert.equal(result.O1, 'V2');
  assert.equal(new Set(Object.values(result)).size, 1);
});

test('후보와 배송지 입력 오류를 명확히 거부한다', () => {
  const input = fixture();
  assert.throws(() => calculateDispatch({ ...input, vehicleIds: [] }), /한 대 이상/);
  assert.throws(() => calculateDispatch({ ...input, vehicleIds: ['UNKNOWN'] }), /찾을 수 없습니다/);
  assert.throws(() => calculateDispatch({ ...input, units: input.units.slice(1) }), /모든 주문/);
  assert.throws(() => calculateDispatch({ ...input, units: [...input.units, unit('DUP', 'W1')] }), /주문을 확인/);
});
