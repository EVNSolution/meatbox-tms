import test from 'node:test';
import assert from 'node:assert/strict';
import { customerEtaText, customerNoticeBody, customerPopupState, nextCustomerPopup } from './customer-renderer.mjs';

test('고객에게는 정확 ETA 대신 30분 범위만 표시한다', () => {
  const delivery = { customerWindowText: '08:00~09:00', preciseTimeText: '08:30', status: 'current' };
  assert.equal(customerEtaText(delivery), '08:00~09:00');
  assert.equal(customerNoticeBody({ kind: 'departure', body: '08:30 도착 예정입니다.' }, delivery), '08:00~09:00 도착 예정입니다.');
  assert.equal(customerEtaText({ status: 'done', completedAt: '08:42' }), '08:42 배송 완료');
});

test('운영자가 작성한 고객 안내는 ETA 시각과 같아도 원문을 유지한다', () => {
  const delivery = { customerWindowText: '06:38 ~ 07:38', preciseTimeText: '07:08' };
  const notice = { kind: 'manual', body: '매장 출입 가능 시간은 07:08입니다.' };
  assert.equal(customerNoticeBody(notice, delivery), notice.body);
});

test('초기 이력은 팝업으로 열지 않고 새 알림만 한 번 선택한다', () => {
  const previous = new Set(['old']);
  assert.equal(nextCustomerPopup(previous, [{ id: 'old' }]), null);
  assert.equal(nextCustomerPopup(previous, [{ id: 'old' }, { id: 'new', title: '안내' }]).id, 'new');
});

test('팝업 기준 ID는 서버가 유지하는 현재 알림 이력 크기로 제한한다', () => {
  const previous = new Set(['pruned', 'kept']);
  const state = customerPopupState(previous, [{ id: 'kept' }, { id: 'new' }]);
  assert.equal(state.popup.id, 'new');
  assert.deepEqual([...state.currentIds], ['kept', 'new']);
  const next = customerPopupState(state.currentIds, [{ id: 'new' }]);
  assert.equal(next.popup, null);
  assert.deepEqual([...next.currentIds], ['new']);
});
