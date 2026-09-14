import test from 'node:test';
import assert from 'node:assert/strict';
import { customerHeadline, publishedEtaText } from './simulation-adapter.mjs';

test('미주문 배송은 사전 계산된 고객 ETA를 공개 값으로 표시하지 않는다', () => {
  const delivery = { ordered: false, officialEta: { time: '07:10' }, customerStatus: { key: 'unordered', label: '주문 전' } };
  assert.equal(publishedEtaText(delivery), '미확인');
  assert.equal(customerHeadline(delivery), '주문 접수 전입니다.');
});

test('고객 문구는 출고 준비와 배송 진행을 구분한다', () => {
  assert.equal(customerHeadline({ customerStatus: { key: 'picking', label: '피킹 중' } }), '상품을 준비하고 있습니다.');
  assert.equal(customerHeadline({ customerStatus: { key: 'staged', label: '상차 대기' } }), '상차를 기다리고 있습니다.');
  assert.equal(customerHeadline({ customerStatus: { key: 'shipping', label: '배송 중' } }), '상품이 배송 중입니다.');
  assert.equal(customerHeadline({ customerStatus: { key: 'nearby', label: '인근 배송 중' } }), '인근에서 배송 중입니다.');
});

test('고객 공개 ETA는 정확 시각 대신 약속 시간대를 우선한다', () => {
  assert.equal(publishedEtaText({
    ordered: true,
    preciseTimeText: '08:35',
    customerWindowText: '08:05 ~ 09:05',
    officialEta: { time: '08:35' },
  }), '08:05 ~ 09:05');
});
