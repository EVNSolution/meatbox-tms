import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorRoute, filterFleetDeliveries, normalizeVehicleFilter, resolveDeliverySelection } from './operations-model.mjs';

test('known operator links retain their page and control tab', () => {
  const expectedRoutes = new Map([
    ['#/orders', {page:'orders', controlTab:'monitor'}],
    ['#/deliveries', {page:'deliveries', controlTab:'monitor'}],
    ['#/control', {page:'control', controlTab:'monitor'}],
    ['#/control/manage', {page:'control', controlTab:'management'}],
    ['#/manage', {page:'control', controlTab:'management'}],
  ]);

  for (const [hash, expected] of expectedRoutes) assert.deepEqual(operatorRoute(hash), expected);
});

test('missing and unknown operator links open dispatch orders', () => {
  for (const hash of [undefined, '', '#', '#/', '#/unknown']) {
    assert.deepEqual(operatorRoute(hash), {page:'orders', controlTab:'monitor'});
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
