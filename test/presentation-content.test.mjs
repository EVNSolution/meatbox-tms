import test from 'node:test';
import assert from 'node:assert/strict';
import { presentationOrderContent } from '../lib/presentation-content.mjs';

test('presentation requests are stable per destination and do not alter source records', () => {
  const order = { id: 'a', name: '매장', address: '서울 1', boxes: 3 };
  const before = structuredClone(order);
  const content = presentationOrderContent(order, '2026-09-16');
  assert.deepEqual(content, presentationOrderContent({ ...order, id: 'b', name: ' 매장 ' }, '2026-09-16'));
  assert.equal(content.customerRequests.items[0].required, true);
  assert.equal(content.customerRequests.source, 'presentation');
  assert.equal(content.tip.updatedAt, null);
  assert.equal(content.items, undefined);
  assert.deepEqual(order, before);
  assert.deepEqual(presentationOrderContent(order, '2026-09-17'), {});
});

test('registered content and explicitly empty requests or conditions take precedence', () => {
  assert.deepEqual(presentationOrderContent({ id: 'a', customerRequests: { items: [] }, tip: { body: '실제 안내' }, transportConditions: [] }, '2026-09-16'), {});
  const content = presentationOrderContent({ id: 'a', customerRequests: { items: [{ id: 'actual', label: '안내' }] } }, '2026-09-16');
  assert.equal(content.customerRequests, undefined);
  assert.equal(content.tip, undefined);
  assert.deepEqual(content.transportConditions, ['보냉 운송', '포장 상태 확인']);
});

test('presentation covers all four supported request categories', () => {
  const kinds = new Set(Array.from({ length: 40 }, (_, index) => presentationOrderContent({ name: `매장 ${index}`, address: '서울' }, '2026-09-16').customerRequests.items[0].kind));
  assert.deepEqual([...kinds].sort(), ['doorstep', 'handoff', 'indoor', 'refrigerator']);
});
