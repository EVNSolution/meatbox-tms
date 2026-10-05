import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCustomerRequests, requiredRequestIds, requestsConfirmed } from './customer-requests.mjs';

const stop = items => ({ customerRequests: items === null ? null : { source: 'example', items } });
const required = [
  { id: 'S1-refrigerator', kind: 'refrigerator', label: '매장 냉장고 안에 보관', required: true },
  { id: 'S1-handoff', kind: 'handoff', label: '직접 전달', required: true },
];

test('필수 고객 요청은 모든 요청 ID를 확인해야 완료된다', () => {
  assert.deepEqual(requiredRequestIds(stop(required)), ['S1-refrigerator', 'S1-handoff']);
  assert.equal(requestsConfirmed(stop(required), ['S1-refrigerator']), false);
  assert.equal(requestsConfirmed(stop(required), ['S1-refrigerator', 'S1-handoff']), true);
  assert.equal(requestsConfirmed(stop([]), []), true);
  assert.equal(requestsConfirmed(stop(null), []), true);
});

test('요청 렌더링은 예시, 필수 체크, 미수신과 요청 없음을 구분한다', () => {
  const confirmation = renderCustomerRequests(stop(required), { confirmation: true, checkedIds: ['S1-refrigerator'] });
  assert.match(confirmation, /예시 요청/);
  assert.match(confirmation, /data-request-check="S1-refrigerator" checked/);
  assert.match(confirmation, /data-request-check="S1-handoff"/);
  assert.match(renderCustomerRequests(stop(null)), /정보 미수신/);
  assert.match(renderCustomerRequests(stop([])), /요청 없음/);
  const compact = renderCustomerRequests(stop(required), { compact: true });
  assert.doesNotMatch(compact, /예시 요청|>2</);
  assert.match(compact, /aria-label="매장 냉장고 안에 보관 요청 내용 보기"/);
  assert.match(compact, /aria-label="직접 전달 요청 내용 보기"/);
  assert.equal((compact.match(/aria-haspopup="dialog"/g) || []).length, 2);
  assert.match(compact, /data-request-info="S1-refrigerator"/);
  assert.match(compact, /data-request-info="S1-handoff"/);
});

test('배송원 상세와 완료 확인은 출처 배지만 빼고 요청과 필수 체크를 유지한다', () => {
  const delivery = stop([{ id: 'S6-indoor', kind: 'indoor', label: '매장 안에 두기', required: true }]);
  for (const confirmation of [false, true]) {
    const html = renderCustomerRequests(delivery, { showSource: false, confirmation, checkedIds: ['S6-indoor'] });
    assert.doesNotMatch(html, /예시 요청/);
    assert.match(html, /매장 안에 두기/);
    assert.match(html, /customer-request-icon/);
    if (confirmation) assert.match(html, /data-request-check="S6-indoor" checked/);
  }
  assert.match(renderCustomerRequests(delivery), /예시 요청/);
  assert.equal(delivery.customerRequests.source, 'example');
});
