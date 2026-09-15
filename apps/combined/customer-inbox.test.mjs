import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxState, noticeKey, visibleNotices, updateInbox } from './customer-inbox.mjs';

test('읽기와 모두 읽기는 알림을 유지하고, 지우기는 이후 새 알림을 숨기지 않는다', () => {
  const notices = [{ id: 1, body: '출발' }, { id: 2, body: '도착' }];
  let state = inboxState(notices, {}, 'boot-a');
  state = updateInbox(notices, state, 'read', noticeKey(notices[0]));
  assert.deepEqual(state.read, [noticeKey(notices[0])]);
  assert.equal(visibleNotices(notices, state).length, 2);
  state = updateInbox(notices, state, 'read-all');
  assert.equal(state.read.length, 2);
  state = updateInbox(notices, state, 'clear');
  assert.deepEqual(visibleNotices(notices, state), []);
  const incoming = [...notices, { id: 3, body: '새 안내' }];
  state = inboxState(incoming, JSON.parse(JSON.stringify(state)), 'boot-a');
  assert.deepEqual(visibleNotices(incoming, state), [incoming[2]]);
  assert.ok(!state.read.includes(noticeKey(incoming[2])));
});

test('매장별 상태는 독립적이고, 서버 재시작 및 변경된 알림 ID는 이전 읽음과 지우기를 재사용하지 않는다', () => {
  const notices = [{ id: 1, body: '출발' }];
  const cleared = updateInbox(notices, inboxState(notices, {}, 'boot-a'), 'clear');
  assert.equal(visibleNotices(notices, inboxState(notices, {}, 'boot-a')).length, 1);
  assert.equal(visibleNotices(notices, inboxState(notices, cleared, 'boot-b')).length, 1);
  const changed = [{ id: 1, body: '새로운 안내' }];
  assert.equal(visibleNotices(changed, inboxState(changed, cleared, 'boot-a')).length, 1);
  assert.deepEqual(inboxState([], cleared, 'boot-a').cleared, []);
});
