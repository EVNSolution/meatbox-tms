import test from 'node:test';
import assert from 'node:assert/strict';
import { driverNoticeText, readDriverNotice } from './driver-notice.ts';

const notice = (extra = {}) => ({ vehicles: 2, push: 'queued', changes: [{ vehicleId: 'G1', text: '배차가 변경되었습니다. 순서 변경' }, { vehicleId: 'G2', text: 'x' }], ...extra });

test('a queued push is reported as a request, never as a delivery to a phone', () => {
  const text = driverNoticeText(readDriverNotice(notice()));
  assert.match(text, /^기사 알림 발송 2대\./);
  assert.match(text, /기기 수신은 확인되지 않습니다/);
});

test('without a push account the answer says that nothing was sent and how many routes changed', () => {
  assert.match(driverNoticeText(readDriverNotice(notice({ push: 'unconfigured', vehicles: 3 }))), /^기사 알림 발송 0대\. 푸시 설정이 없어 보내지 않았습니다\(경로가 바뀐 차량 3대\)/);
});

test('an unknown push state is not described as sent, and a missing or malformed notice is silent', () => {
  assert.match(driverNoticeText(readDriverNotice(notice({ push: 'mystery' }))), /기사 알림 상태를 확인하지 못했습니다/);
  for (const raw of [undefined, null, 'x', {}, { vehicles: 0, push: 'queued' }, { vehicles: 1.5, push: 'queued' }, { vehicles: 1 }]) assert.equal(driverNoticeText(readDriverNotice(raw)), '');
  assert.deepEqual(readDriverNotice({ vehicles: 1, push: 'queued', changes: [null, { vehicleId: 'G1' }] }).changes, []);
});
