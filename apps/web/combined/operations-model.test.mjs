import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorRoute, routeHash, subtabs, controlDataPresentation, filterFleetDeliveries, normalizeVehicleFilter, resolveDeliverySelection } from './operations-model.mjs';

test('관제의 로딩과 조회 실패는 확인된 자료 없음과 구분한다', () => {
  assert.deepEqual(controlDataPresentation(null), { empty: false, message: '배송 자료를 확인하고 있습니다.' });
  const error = '배송 상태를 불러오지 못했습니다.';
  assert.deepEqual(controlDataPresentation({ date: '2026-10-06', empty: false }, error), { empty: false, message: error });
  assert.deepEqual(controlDataPresentation({ date: '2026-10-06', empty: true }, error), {
    empty: true, message: '2026-10-06에 배송 자료가 없습니다. 배차가 확정되면 관제에 표시됩니다.',
  });
  assert.deepEqual(controlDataPresentation({ date: 'invalid', empty: true, invalid: true }, error), {
    empty: false, message: '요청한 날짜가 올바르지 않습니다. 조회 날짜를 다시 선택해 주세요.',
  });
});

test('known operator links retain their page and control tab', () => {
  const expectedRoutes = new Map([
    ['#/orders', {page:'orders', subtab:'plan', controlTab:'monitor'}],
    ['#/orders/zones', {page:'orders', subtab:'zones', controlTab:'monitor'}],
    ['#/orders/list', {page:'orders', subtab:'list', controlTab:'monitor'}],
    ['#/orders/nope', {page:'orders', subtab:'plan', controlTab:'monitor'}],
    ['#/deliveries', {page:'deliveries', subtab:'', controlTab:'monitor'}],
    ['#/control', {page:'control', subtab:'map', controlTab:'monitor'}],
    ['#/control/stops', {page:'control', subtab:'stops', controlTab:'monitor'}],
    ['#/control/records', {page:'control', subtab:'records', controlTab:'management'}],
    ['#/control/manage', {page:'control', subtab:'records', controlTab:'management'}],
    ['#/manage', {page:'control', subtab:'records', controlTab:'management'}],
  ]);

  for (const [hash, expected] of expectedRoutes) assert.deepEqual(operatorRoute(hash), expected);
});

test('missing and unknown operator links open dispatch orders', () => {
  for (const hash of [undefined, '', '#', '#/', '#/unknown']) {
    assert.deepEqual(operatorRoute(hash), {page:'orders', subtab:'plan', controlTab:'monitor'});
  }
});

test('fleet deliveries filter by vehicle, status, destination, address, and driver', () => {
  const rows = [
    {id:'S1',name:'문정갈비',address:'서울 송파구',status:'current',vehicleId:'V1',vehicle:{plate:'서울80아1001',driver:'김민수'}},
    {id:'V2-S1',name:'샘플 배송지',address:'위치 데이터 대기',status:'pending',vehicleId:'V2',vehicle:{plate:'서울80아1002',driver:'박서준'}},
  ];
  assert.deepEqual(filterFleetDeliveries(rows, {vehicleId:'V2'}).map(item=>item.id), ['V2-S1']);
  assert.deepEqual(filterFleetDeliveries(rows, {query:' 송파 ',status:'current'}).map(item=>item.id), ['S1']);
  assert.deepEqual(filterFleetDeliveries(rows, {query:'박서준'}).map(item=>item.id), ['V2-S1']);
  assert.deepEqual(filterFleetDeliveries(rows, {query:'없는 배송지'}), []);
});

test('선택 차량이 새 데이터에서 사라지면 전체 차량 필터로 복구한다', () => {
  const vehicles = [{ id: 'V2' }];
  assert.equal(normalizeVehicleFilter('V1', vehicles), 'all');
  assert.equal(normalizeVehicleFilter('V2', vehicles), 'V2');
  assert.equal(normalizeVehicleFilter('all', vehicles), 'all');
  assert.equal(normalizeVehicleFilter('V1'), 'all');
});


test('filtered-out and unreceived selections remain stable across operator pages', () => {
  const data = {customerStopId:'S5', deliveries:[
    {id:'S1', ordered:true, name:'문정갈비',address:'서울',items:[],status:'pending'},
    {id:'S5', ordered:false, name:'호수정육식당',address:'서울',items:[],status:'pending'},
  ], fleetDeliveries:[
    {id:'S1', name:'문정갈비'}, {id:'S5', name:'호수정육식당'}, {id:'V2-S1',name:'샘플 배송지'},
  ]};
  assert.equal(resolveDeliverySelection(data, 'V2-S1').id, 'V2-S1');
  assert.equal(resolveDeliverySelection(data, 'S5').id, 'S5');
  assert.equal(resolveDeliverySelection(data, null).id, 'S5');
});

test('route hashes omit the default sub-tab and round-trip the others', () => {
  assert.equal(routeHash('orders', 'plan'), '#/orders');
  assert.equal(routeHash('orders', 'zones'), '#/orders/zones');
  assert.equal(routeHash('control', 'map'), '#/control');
  assert.equal(routeHash('control', 'records'), '#/control/records');
  assert.equal(routeHash('deliveries', ''), '#/deliveries');
  for (const hash of ['#/orders', '#/orders/zones', '#/orders/list', '#/control', '#/control/stops', '#/control/records']) {
    const route = operatorRoute(hash);
    assert.equal(routeHash(route.page, route.subtab), hash);
  }
});

test('the temperature tab of the control screen has its own route and keeps the vehicle details column', () => {
  assert.deepEqual(operatorRoute('#/control/temperature'), { page: 'control', subtab: 'temperature', controlTab: 'temperature' });
  assert.equal(routeHash('control', 'temperature'), '#/control/temperature');
  assert.deepEqual(subtabs.control.map(([id]) => id), ['map', 'stops', 'records', 'temperature']);
  assert.equal(operatorRoute('#/control/records').controlTab, 'management');
  assert.equal(operatorRoute('#/control/stops').controlTab, 'monitor');
});
