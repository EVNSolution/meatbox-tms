import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePushData } from './push';
import { pushEffect } from './pushEffect';

const scope = { date: '2026-11-02', vehicleId: 'G1' };
const parse = (data: Record<string, unknown>, tapped = false) =>
  parsePushData({ date: '2026-11-02', vehicleId: 'G1', ...data }, {}, tapped);

test('a route change rereads the day and shows the server text as a banner', () => {
  const push = parse({ type: 'route_changed', messageId: 'route-9', body: '배차가 변경되었습니다. 순서 변경', title: '미트박스 배송' });
  assert.deepEqual(pushEffect(push!, scope), {
    refreshDay: true, reloadMessages: false, seenMessageId: null,
    banner: { title: '배차 변경', body: '배차가 변경되었습니다. 순서 변경' }, openMessages: false,
  });
});

test('a route change without text still says that the plan changed', () => {
  const push = parse({ type: 'route_changed', body: '' });
  assert.equal(pushEffect(push!, scope)?.banner?.body, '배차가 변경되었습니다.');
});

test('an operator message reloads the messages, marks itself seen and opens the list when tapped', () => {
  const push = parse({ type: 'ops_message', messageId: 'm1', body: '확인 부탁' }, true);
  assert.deepEqual(pushEffect(push!, scope), {
    refreshDay: false, reloadMessages: true, seenMessageId: 'm1',
    banner: { title: '운영팀 메시지', body: '확인 부탁' }, openMessages: true,
  });
});

test('a push for another day or vehicle changes nothing', () => {
  assert.equal(pushEffect(parse({ type: 'route_changed' })!, { ...scope, vehicleId: 'G2' }), null);
  assert.equal(pushEffect(parse({ type: 'route_changed' })!, { ...scope, date: '2026-11-03' }), null);
});
