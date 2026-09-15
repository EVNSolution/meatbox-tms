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

test('이미 안내한 시간대와 실제 완료 시각은 현재 ETA로 다시 쓰지 않는다', () => {
  const delivery = { customerWindowText: '06:00 ~ 07:00', preciseTimeText: '06:30' };
  for (const notice of [
    { kind: 'departure', body: '도착 예정 시간은 06:30 ~ 07:30입니다.' },
    { kind: 'delay', body: '새 도착 예정 시간은 05:30 ~ 06:30입니다.' },
    { kind: 'completed', body: '06:30 상품 전달을 완료했습니다.' },
    { kind: 'complete', body: '06:30 문 앞에 상품을 전달했습니다.' },
    { kind: 'arrival', body: '06:30 기사님이 도착했습니다.' },
  ]) assert.equal(customerNoticeBody(notice, delivery), notice.body);
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

test('한 번의 상태 전환에서 여러 알림이 들어오면 마지막 상태 알림을 팝업으로 표시한다', () => {
  const previous = new Set([1]);
  const notices = [{ id: 1, kind: 'ready' }, { id: 2, kind: 'delay' }, { id: 3, kind: 'shipping' }];
  assert.equal(nextCustomerPopup(previous, notices).id, 3);
  assert.equal(nextCustomerPopup(new Set([1, 2, 3]), [...notices, { id: 4, kind: 'shipping' }]).id, 4);
});
