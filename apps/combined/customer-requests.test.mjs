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
  assert.match(compact, /aria-label="예시 요청:/);
  assert.match(compact, /<span>예시 요청 2<\/span>/);
});
