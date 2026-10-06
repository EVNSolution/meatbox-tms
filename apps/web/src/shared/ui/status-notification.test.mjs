import test from 'node:test';
import assert from 'node:assert/strict';
import { mountStatusNotification } from './status-notification.mjs';

function fixture() {
  let now = 0, sequence = 0;
  const timers = new Map();
  const node = () => ({
    listeners: new Map(), textContent: '',
    addEventListener(event, handler) { this.listeners.set(event, handler); },
    removeEventListener(event) { this.listeners.delete(event); },
    dispatch(event, detail = {}) { this.listeners.get(event)?.(detail); },
  });
  const message = node(), close = node(), element = node();
  element.ownerDocument = { activeElement: null };
  element.contains = target => target === close;
  element.matches = () => false;
  element.querySelector = selector => selector === '[data-status-message]' ? message : close;
  const clock = {
    now: () => now,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!timer || timer.at > end) break;
      now = timer.at; timers.delete(id); timer.callback();
    }
    now = end;
  }
  return { element, message, close, timers, advance, notification: mountStatusNotification({ element, clock }) };
}
const empty = (context = 'orders:2026-10-06') => ({ context, key: `${context}:empty`, message: '2026-10-06에 등록된 주문이 없습니다.' });

test('상단 알림은 polite 상태 영역과 닫기 버튼을 제공하고 5초 뒤 사라진다', () => {
  const { element, message, notification, advance } = fixture();
  assert.equal(element.hidden, true);
  assert.match(element.innerHTML, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(element.innerHTML, /aria-label="알림 닫기"/);
  notification.update({ ...empty(), message: '<script>자료 없음</script>' });
  assert.equal(element.hidden, false);
  assert.equal(message.textContent, '<script>자료 없음</script>');
  advance(4999); assert.equal(element.hidden, false);
  advance(1); assert.equal(element.hidden, true); assert.equal(message.textContent, '');
});

test('같은 날짜·페이지의 반복 갱신은 시간을 연장하거나 닫힌 알림을 다시 보이지 않는다', () => {
  const { element, notification, advance, timers } = fixture();
  notification.update(empty()); advance(4000);
  notification.update(empty()); assert.equal(timers.size, 1);
  advance(1000); assert.equal(element.hidden, true);
  notification.update(empty()); assert.equal(element.hidden, true); assert.equal(timers.size, 0);
  notification.update({ context: empty().context });
  notification.update(empty()); assert.equal(element.hidden, true);
});

test('날짜나 메뉴를 변경하면 이전 알림을 제거하고 새 알림을 한 번 표시한다', () => {
  const { element, message, notification, advance, timers } = fixture();
  notification.update(empty()); advance(4000);
  notification.update({ ...empty('control:2026-10-06'), message: '배송 자료 없음' });
  assert.equal(message.textContent, '배송 자료 없음'); assert.equal(timers.size, 1);
  advance(1000); assert.equal(element.hidden, false);
  notification.update({ context: 'deliveries:2026-10-06' });
  assert.equal(element.hidden, true); assert.equal(message.textContent, ''); assert.equal(timers.size, 0);
  notification.update(empty()); assert.equal(element.hidden, false);
  notification.update(empty('orders:2026-10-07')); advance(4999);
  assert.equal(element.hidden, false); advance(1); assert.equal(element.hidden, true);
});

test('마우스와 키보드 포커스가 모두 벗어난 뒤 남은 시간만 진행한다', () => {
  const { element, close, notification, advance, timers } = fixture();
  notification.update(empty()); advance(2000);
  element.dispatch('mouseenter'); assert.equal(timers.size, 0);
  advance(10_000); assert.equal(element.hidden, false);
  element.dispatch('focusin'); element.dispatch('mouseleave');
  advance(10_000); assert.equal(element.hidden, false);
  element.dispatch('focusout', { relatedTarget: close }); assert.equal(timers.size, 0);
  element.dispatch('focusout', { relatedTarget: null }); assert.equal(timers.size, 1);
  advance(2999); assert.equal(element.hidden, false);
  notification.update(empty()); advance(1); assert.equal(element.hidden, true);
});

test('수동 닫기와 정상 복구는 타이머를 제거하며 반복 조회로 알림을 다시 열지 않는다', () => {
  const { element, close, notification, timers } = fixture();
  notification.update(empty()); close.dispatch('click');
  assert.equal(element.hidden, true); assert.equal(timers.size, 0);
  notification.update(empty()); assert.equal(element.hidden, true);
  notification.update(empty('control:2026-10-06')); assert.equal(element.hidden, false);
  notification.update({ context: 'control:2026-10-06' });
  assert.equal(element.hidden, true); assert.equal(timers.size, 0);
});

test('해제하면 타이머와 이벤트를 제거하고 이후 갱신을 무시한다', () => {
  const { element, close, notification, timers } = fixture();
  notification.update(empty()); notification.destroy();
  assert.equal(element.hidden, true); assert.equal(timers.size, 0);
  assert.equal(element.listeners.size, 0); assert.equal(close.listeners.size, 0);
  notification.update(empty('orders:2026-10-07')); assert.equal(element.hidden, true);
});
