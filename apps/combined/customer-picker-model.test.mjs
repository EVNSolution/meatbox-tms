import test from 'node:test';
import assert from 'node:assert/strict';
import { customerPickerPage, updateCustomerPickerState } from './customer-picker-model.mjs';

const deliveries = Array.from({ length: 4550 }, (_, index) => ({
  id: `STORE-${index + 1}`,
  name: index === 87 ? '송파 정육점' : `매장 ${index + 1}`,
  address: index === 201 ? '서울 송파구 위례성대로 22' : `서울 주소 ${index + 1}`,
}));

test('고객 매장 선택기는 전체 데이터에서 검색하고 한 페이지에 최대 50개만 반환한다', () => {
  const first = customerPickerPage(deliveries, { query: '', page: 1 });
  const last = customerPickerPage(deliveries, { query: '', page: 91 });
  assert.deepEqual({ total: first.total, count: first.items.length, pageCount: first.pageCount }, { total: 4550, count: 50, pageCount: 91 });
  assert.deepEqual({ start: last.start, end: last.end, count: last.items.length }, { start: 4501, end: 4550, count: 50 });
  assert.equal(customerPickerPage(deliveries, { query: '송파 정육점', page: 1 }).items[0].id, 'STORE-88');
  assert.equal(customerPickerPage(deliveries, { query: '위례성대로', page: 1 }).items[0].id, 'STORE-202');
  assert.equal(customerPickerPage(deliveries, { query: 'store-4550', page: 1 }).items[0].id, 'STORE-4550');
});

test('검색 결과 없음과 검색 초기화는 첫 페이지 상태를 유지한다', () => {
  const empty = customerPickerPage(deliveries, { query: '없는 매장', page: 9 });
  assert.deepEqual({ total: empty.total, page: empty.page, items: empty.items }, { total: 0, page: 1, items: [] });

  const searched = updateCustomerPickerState({ query: '', page: 40 }, { query: '송파' });
  const reset = updateCustomerPickerState(searched, { query: '' });
  assert.deepEqual(searched, { query: '송파', page: 1 });
  assert.deepEqual(reset, { query: '', page: 1 });
  assert.equal(customerPickerPage(deliveries, reset).total, 4550);
});

test('실시간 갱신은 검색어와 유효한 페이지를 그대로 사용하고 축소된 결과에서는 페이지를 보정한다', () => {
  const state = updateCustomerPickerState({ query: '매장', page: 3 });
  assert.deepEqual(state, { query: '매장', page: 3 });
  assert.equal(customerPickerPage(deliveries, state).page, 3);
  assert.equal(customerPickerPage(deliveries.slice(0, 60), state).page, 2);
});
