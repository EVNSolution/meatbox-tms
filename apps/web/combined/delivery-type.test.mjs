import test from 'node:test';
import assert from 'node:assert/strict';
import { filterByType, hasTypes, typeCounts, typeNote } from './delivery-type.ts';

const orders = [{ id: 1, deliveryType: 'fresh' }, { id: 2, deliveryType: 'fresh' }, { id: 3, deliveryType: 'parcel' }, { id: 4 }, { id: 5, deliveryType: 'other' }];

test('orders are counted by kind and the ones without a known kind are counted apart', () => {
  assert.deepEqual(typeCounts(orders), { fresh: 2, parcel: 1, unknown: 2, total: 5 });
  assert.deepEqual(typeCounts(undefined), { fresh: 0, parcel: 0, unknown: 0, total: 0 });
  assert.equal(hasTypes(typeCounts(orders)), true);
  assert.equal(hasTypes(typeCounts([{ id: 1 }])), false);
});

test('a filter keeps the orders of that kind only, and "all" is the same array', () => {
  assert.deepEqual(filterByType(orders, 'fresh').map(order => order.id), [1, 2]);
  assert.deepEqual(filterByType(orders, 'parcel').map(order => order.id), [3]);
  assert.equal(filterByType(orders, 'all'), orders);
  assert.equal(filterByType(undefined, 'fresh'), undefined);
});

test('a day from the prepared CSV says that it has no kinds, and a Meatbox day says that dispatch still uses every order', () => {
  assert.match(typeNote(typeCounts([{ id: 1 }, { id: 2 }]), 'all'), /CSV\)에는 배송 구분이 없어/);
  const note = typeNote(typeCounts(orders), 'fresh');
  assert.match(note, /^신선만 표시 중입니다\. 배차 계산과 전송은 구분과 관계없이 전체 주문 기준입니다\./);
  assert.match(note, /구분이 없는 주문 2건은 전체에서만 보입니다/);
  assert.equal(typeNote(typeCounts([]), 'all'), '');
});
