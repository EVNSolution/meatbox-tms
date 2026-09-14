import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorRoute, filterFleetDeliveries, resolveDeliverySelection } from './operations-model.mjs';

test('management links resolve inside control and unknown links fall back safely', () => {
  for (const hash of ['#/manage', '#/control/manage']) assert.deepEqual(operatorRoute(hash), {page:'control', controlTab:'management'});
  assert.deepEqual(operatorRoute('#/orders'), {page:'orders', controlTab:'monitor'});
  assert.deepEqual(operatorRoute('#/unknown'), {page:'deliveries', controlTab:'monitor'});
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
