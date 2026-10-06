export function mountStatusNotification({ element, duration = 5000, clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
} }) {
  element.innerHTML = '<p data-status-message role="status" aria-live="polite" aria-atomic="true"></p><button type="button" data-status-close aria-label="알림 닫기">×</button>';
  element.hidden = true;
  const messageNode = element.querySelector('[data-status-message]');
  const closeButton = element.querySelector('[data-status-close]');
  let context, lastKey, timer = null, deadline = 0, remaining = duration, destroyed = false;
  const paused = new Set();
  const listeners = [];
  const listen = (node, event, handler) => {
    node.addEventListener(event, handler);
    listeners.push(() => node.removeEventListener(event, handler));
  };
  function cancelTimer() { clock.clearTimeout(timer); timer = null; }
  function dismiss() {
    cancelTimer();
    element.hidden = true;
    messageNode.textContent = '';
    paused.clear();
  }
  function schedule() {
    if (destroyed || element.hidden || paused.size || timer !== null) return;
    deadline = clock.now() + remaining;
    timer = clock.setTimeout(() => { timer = null; dismiss(); }, remaining);
  }
  function pause(reason) {
    if (element.hidden || paused.has(reason)) return;
    if (!paused.size && timer !== null) { remaining = Math.max(0, deadline - clock.now()); cancelTimer(); }
    paused.add(reason);
  }
  function resume(reason) { paused.delete(reason); schedule(); }
  listen(element, 'mouseenter', () => pause('hover'));
  listen(element, 'mouseleave', () => resume('hover'));
  listen(element, 'focusin', () => pause('focus'));
  listen(element, 'focusout', event => { if (!element.contains(event.relatedTarget)) resume('focus'); });
  listen(closeButton, 'click', dismiss);
  return {
    update({ context: nextContext, key, message = '' }) {
      if (destroyed) return;
      if (context !== nextContext) { dismiss(); context = nextContext; lastKey = undefined; }
      if (!message || !key) { dismiss(); return; }
      if (key === lastKey) return;
      dismiss(); lastKey = key; remaining = duration;
      element.hidden = false;
      messageNode.textContent = message;
      if (element.matches?.(':hover')) paused.add('hover');
      if (element.contains(element.ownerDocument?.activeElement)) paused.add('focus');
      schedule();
    },
    destroy() { destroyed = true; dismiss(); listeners.splice(0).forEach(remove => remove()); },
  };
}
