import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorRoute, filterOrders, orderStage, resolveDeliverySelection } from './operations-model.mjs';

test('management links resolve inside control and unknown links fall back safely', () => {
  for (const hash of ['#/manage', '#/control/manage']) assert.deepEqual(operatorRoute(hash), {page:'control', controlTab:'management'});
  assert.deepEqual(operatorRoute('#/orders'), {page:'orders', controlTab:'monitor'});
  assert.deepEqual(operatorRoute('#/unknown'), {page:'deliveries', controlTab:'monitor'});
});

test('only received orders appear and live shipping, held, and completed states filter correctly', () => {
  const delivery = {id:'S1', ordered:true, name:'문정갈비', address:'서울', items:[{name:'한돈 삼겹살'}], status:'pending', customerStatus:{key:'paid'}};
  const rows = [delivery, {...delivery,id:'S2',ordered:false}, {...delivery,id:'S3',customerStatus:{key:'shipping'}}, {...delivery,id:'S4',status:'done'}, {...delivery,id:'S5',status:'skipped'}];
  assert.deepEqual(filterOrders(rows).map(item=>item.id), ['S1','S3','S4','S5']);
  assert.deepEqual(filterOrders(rows, ' 삼겹살 ', 'shipping').map(item=>item.id), ['S3']);
  assert.deepEqual(filterOrders(rows, '', 'held').map(item=>item.id), ['S5']);
  assert.deepEqual(filterOrders(rows, '', 'done').map(item=>item.id), ['S4']);
  assert.equal(orderStage(delivery), 'preparing');
  assert.deepEqual(filterOrders(rows,'없는 상품'),[]);
});


test('filtered-out and unreceived selections remain stable across operator pages', () => {
  const data = {customerStopId:'S5', deliveries:[
    {id:'S1', ordered:true, name:'문정갈비',address:'서울',items:[],status:'pending'},
    {id:'S5', ordered:false, name:'호수정육식당',address:'서울',items:[],status:'pending'},
  ]};
  assert.deepEqual(filterOrders(data.deliveries).map(item=>item.id), ['S1']);
  assert.equal(resolveDeliverySelection(data, 'S5').id, 'S5');
  assert.deepEqual(filterOrders(data.deliveries, 'no match'), []);
  assert.equal(resolveDeliverySelection(data, 'S5').id, 'S5');
  assert.equal(resolveDeliverySelection(data, null).id, 'S5');
});
