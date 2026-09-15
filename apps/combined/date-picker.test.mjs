import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonth, mountDatePicker } from './date-picker.mjs';

class FakeNode {
  constructor(name = '') {
    this.name = name;
    this.innerHTML = '';
    this.textContent = '';
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.disabled = false;
    this.open = false;
    this.focused = false;
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getBoundingClientRect() { return this.name === 'dialog' ? { height: 340 } : { left: 20, top: 20, right: 120, bottom: 56 }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.({ target: this }); }
  focus() { this.focused = true; }
  querySelector(selector) {
    const date = selector.match(/data-date="([^"]+)"/)?.[1];
    if (!date || !this.innerHTML.includes(`data-date="${date}"`) || this.innerHTML.includes(`data-date="${date}" aria-label`) && this.innerHTML.match(new RegExp(`data-date="${date}"[^>]* disabled`))) return null;
    const day = new FakeNode('day');
    day.dataset.date = date;
    return day;
  }
}

function fixture() {
  const nodes = Object.fromEntries(['trigger', 'dialog', 'month', 'grid', 'previous', 'next', 'value'].map(name => [name, new FakeNode(name)]));
  nodes.dialog.querySelector = selector => {
    const date = selector.match(/data-date="([^"]+)"/)?.[1];
    if (!date || !nodes.grid.innerHTML.includes(`data-date="${date}"`)) return null;
    const day = new FakeNode('day');
    day.dataset.date = date;
    day.focus = () => { nodes.dialog.focusedDate = date; };
    return day;
  };
  const selectors = {
    '[data-date-trigger]': 'trigger', '[data-date-dialog]': 'dialog', '[data-date-month]': 'month',
    '[data-date-grid]': 'grid', '[data-date-previous]': 'previous', '[data-date-next]': 'next', '[data-date-value]': 'value',
  };
  const element = new FakeNode('root');
  element.ownerDocument = { defaultView: { innerWidth: 320, innerHeight: 700 } };
  element.querySelector = selector => nodes[selectors[selector]];
  return { element, nodes };
}

function eventTarget(date, disabled = false) {
  return { closest: () => ({ dataset: { date }, disabled }) };
}

test('월 모델은 윤년과 시작 요일, 선택일, 누락된 운영일을 구분한다', () => {
  const model = calendarMonth('2028-02', ['2028-02-01', '2028-02-29'], '2028-02-29');
  assert.equal(model.title, '2028년 2월');
  assert.equal(model.days.length, 29);
  assert.equal(model.leading, 2);
  assert.deepEqual(model.days[0], { date: '2028-02-01', day: 1, available: true, selected: false });
  assert.deepEqual(model.days[28], { date: '2028-02-29', day: 29, available: true, selected: true });
  assert.equal(model.days[1].available, false);
});

test('선택한 날짜와 요일을 한 줄로 표시하고 운영일만 변경한다', () => {
  const { element, nodes } = fixture();
  const changes = [];
  const picker = mountDatePicker({ element, label: '배차일 선택', onChange: date => changes.push(date) });
  picker.update({ value: '2026-09-17', dates: [{ date: '2026-09-17' }, { date: '2026-09-18' }] });
  assert.equal(nodes.value.textContent, '2026.09.17 목');
  assert.equal(nodes.trigger.attributes['aria-label'], '배차일 선택, 2026년 9월 17일 목요일');

  nodes.trigger.listeners.click();
  assert.equal(nodes.dialog.open, true);
  assert.equal(nodes.month.textContent, '2026년 9월');
  nodes.dialog.listeners.click({ target: eventTarget('2026-09-16', true) });
  assert.deepEqual(changes, []);
  nodes.dialog.listeners.click({ target: eventTarget('2026-09-18') });
  assert.deepEqual(changes, ['2026-09-18']);
  assert.equal(nodes.dialog.open, false);
  assert.equal(nodes.trigger.focused, true);
  picker.destroy();
});

test('동일 데이터 갱신은 사용자가 둘러보던 달과 열린 상태를 유지한다', () => {
  const { element, nodes } = fixture();
  const picker = mountDatePicker({ element });
  const state = { value: '2026-09-17', dates: ['2026-09-17', '2026-10-02'] };
  picker.update(state);
  nodes.trigger.listeners.click();
  nodes.next.listeners.click();
  assert.equal(nodes.month.textContent, '2026년 10월');
  picker.update({ value: state.value, dates: [...state.dates] });
  assert.equal(nodes.month.textContent, '2026년 10월');
  assert.equal(nodes.dialog.open, true);
  picker.destroy();
});

test('키보드 이동은 누락일을 건너뛰고 달 경계를 이동하며 취소와 바깥 클릭은 포커스를 돌린다', () => {
  const { element, nodes } = fixture();
  const picker = mountDatePicker({ element });
  picker.update({ value: '2026-09-30', dates: ['2026-09-30', '2026-10-02'] });
  nodes.trigger.listeners.click();
  let prevented = false;
  nodes.dialog.listeners.keydown({
    target: eventTarget('2026-09-30'), key: 'ArrowRight', preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(nodes.month.textContent, '2026년 10월');
  assert.equal(nodes.dialog.focusedDate, '2026-10-02');

  let cancelPrevented = false;
  nodes.dialog.listeners.cancel({ preventDefault() { cancelPrevented = true; } });
  assert.equal(cancelPrevented, true);
  assert.equal(nodes.dialog.open, false);
  nodes.trigger.listeners.click();
  nodes.dialog.listeners.click({ target: nodes.dialog });
  assert.equal(nodes.dialog.open, false);
  assert.equal(nodes.trigger.focused, true);
  picker.destroy();
});
