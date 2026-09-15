const DAY_MS = 86_400_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
let pickerCount = 0;

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(value, days) {
  const date = parseDate(value);
  if (!date) return null;
  return isoDate(new Date(date.getTime() + days * DAY_MS));
}

function monthKey(value) {
  return String(value || '').slice(0, 7);
}

function shiftMonth(month, offset) {
  const date = parseDate(`${month}-01`);
  if (!date) return month;
  date.setUTCMonth(date.getUTCMonth() + offset);
  return isoDate(date).slice(0, 7);
}

function monthTitle(month) {
  const [year, number] = month.split('-').map(Number);
  return `${year}년 ${number}월`;
}

function calendarIcon() {
  return '<svg class="date-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 3v3m10-3v3M4.5 9h15M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>';
}

function chevron(direction) {
  const path = direction < 0 ? 'm14 6-6 6 6 6' : 'm10 6 6 6-6 6';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

function dateLabel(value, long = false) {
  const date = parseDate(value);
  if (!date) return '날짜를 선택하세요';
  const [year, month, day] = value.split('-').map(Number);
  return long
    ? `${year}년 ${month}월 ${day}일 ${WEEKDAYS[date.getUTCDay()]}요일`
    : `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')} ${WEEKDAYS[date.getUTCDay()]}`;
}

function normalizeDates(dates) {
  return [...new Set((Array.isArray(dates) ? dates : [])
    .map(item => typeof item === 'string' ? item : item?.date)
    .filter(value => parseDate(value)))]
    .sort();
}

export function calendarMonth(month, availableDates, selectedDate = '') {
  const first = parseDate(`${month}-01`);
  if (!first) return { month, title: '', leading: 0, days: [] };
  const next = parseDate(`${shiftMonth(month, 1)}-01`);
  const count = Math.round((next - first) / DAY_MS);
  const available = availableDates instanceof Set ? availableDates : new Set(normalizeDates(availableDates));
  return {
    month,
    title: monthTitle(month),
    leading: first.getUTCDay(),
    days: Array.from({ length: count }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, '0')}`;
      return { date, day: index + 1, available: available.has(date), selected: date === selectedDate };
    }),
  };
}

function dayButton(day) {
  const state = day.selected ? ' date-picker-day-selected' : '';
  return `<button class="date-picker-day${state}" type="button" role="gridcell" data-date="${day.date}" aria-label="${dateLabel(day.date, true)}" aria-selected="${day.selected}" aria-disabled="${!day.available}"${day.available ? '' : ' disabled'}>${day.day}</button>`;
}

function keyedDate(current, key, available) {
  const date = parseDate(current);
  if (!date) return null;
  let offset = 0;
  if (key === 'ArrowLeft') offset = -1;
  if (key === 'ArrowRight') offset = 1;
  if (key === 'ArrowUp') offset = -7;
  if (key === 'ArrowDown') offset = 7;
  if (key === 'Home') offset = -date.getUTCDay();
  if (key === 'End') offset = 6 - date.getUTCDay();
  if (key === 'PageUp' || key === 'PageDown') {
    const direction = key === 'PageUp' ? -1 : 1;
    const targetMonth = shiftMonth(monthKey(current), direction);
    const targetLast = calendarMonth(targetMonth, available).days.length;
    const target = `${targetMonth}-${String(Math.min(date.getUTCDate(), targetLast)).padStart(2, '0')}`;
    if (available.has(target)) return target;
    const monthDates = [...available].filter(value => monthKey(value) === targetMonth);
    return monthDates.reduce((best, value) => !best || Math.abs(Number(value.slice(8)) - date.getUTCDate()) < Math.abs(Number(best.slice(8)) - date.getUTCDate()) ? value : best, null);
  }
  if (!offset) return null;
  const direction = Math.sign(offset);
  let target = shiftDate(current, offset);
  for (let index = 0; target && index < 370; index += 1, target = shiftDate(target, direction)) {
    if (available.has(target)) return target;
    if ((key === 'Home' || key === 'End') && parseDate(target).getUTCDay() === (direction < 0 ? 6 : 0)) break;
  }
  return null;
}

export function mountDatePicker({ element, label = '배차일 선택', onChange = () => {} } = {}) {
  if (!element) throw new Error('date picker element is required');
  const id = `date-picker-${++pickerCount}`;
  element.innerHTML = `<div class="date-picker"><button class="date-picker-trigger" type="button" data-date-trigger aria-haspopup="dialog" aria-controls="${id}">${calendarIcon()}<span data-date-value>날짜를 선택하세요</span></button><dialog class="date-picker-dialog" id="${id}" data-date-dialog aria-modal="true" aria-labelledby="${id}-title"><div class="date-picker-panel"><header><button class="date-picker-month-button" type="button" data-date-previous aria-label="이전 달">${chevron(-1)}</button><strong id="${id}-title" data-date-month></strong><button class="date-picker-month-button" type="button" data-date-next aria-label="다음 달">${chevron(1)}</button></header><div class="date-picker-weekdays" role="row">${WEEKDAYS.map(day => `<span role="columnheader">${day}</span>`).join('')}</div><div class="date-picker-grid" data-date-grid role="grid"></div></div></dialog></div>`;

  const trigger = element.querySelector('[data-date-trigger]');
  const dialog = element.querySelector('[data-date-dialog]');
  const title = element.querySelector('[data-date-month]');
  const grid = element.querySelector('[data-date-grid]');
  const previous = element.querySelector('[data-date-previous]');
  const next = element.querySelector('[data-date-next]');
  const valueText = element.querySelector('[data-date-value]');
  const doc = element.ownerDocument || globalThis.document;
  const view = doc?.defaultView || globalThis.window;
  let selected = '';
  let availableList = [];
  let available = new Set();
  let browsedMonth = '';
  let disabled = false;
  let renderedKey = '';
  let pendingFocus = '';

  function renderCalendar() {
    if (!browsedMonth) return;
    const model = calendarMonth(browsedMonth, available, selected);
    title.textContent = model.title;
    grid.innerHTML = `${'<span class="date-picker-blank" aria-hidden="true"></span>'.repeat(model.leading)}${model.days.map(dayButton).join('')}`;
    const firstMonth = monthKey(availableList[0]);
    const lastMonth = monthKey(availableList.at(-1));
    previous.disabled = !firstMonth || browsedMonth <= firstMonth;
    next.disabled = !lastMonth || browsedMonth >= lastMonth;
    if (pendingFocus) {
      dialog.querySelector(`[data-date="${pendingFocus}"]`)?.focus();
      pendingFocus = '';
    }
  }

  function positionDialog() {
    const rect = trigger.getBoundingClientRect?.();
    if (!rect || !view) return;
    const width = Math.min(304, Math.max(240, view.innerWidth - 16));
    const left = Math.min(Math.max(8, rect.left), Math.max(8, view.innerWidth - width - 8));
    const height = dialog.getBoundingClientRect?.().height || 354;
    const below = rect.bottom + 8;
    const top = below + height <= view.innerHeight - 8 ? below : Math.max(8, rect.top - height - 8);
    dialog.style.setProperty('--date-picker-left', `${left}px`);
    dialog.style.setProperty('--date-picker-top', `${top}px`);
    dialog.style.setProperty('--date-picker-width', `${width}px`);
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
    else trigger.focus();
  }

  function openDialog() {
    if (disabled || !availableList.length) return;
    if (!browsedMonth) browsedMonth = monthKey(selected || availableList[0]);
    renderCalendar();
    dialog.showModal();
    positionDialog();
    const focusDate = available.has(selected) && monthKey(selected) === browsedMonth
      ? selected
      : availableList.find(value => monthKey(value) === browsedMonth);
    dialog.querySelector(`[data-date="${focusDate}"]`)?.focus();
  }

  function moveMonth(offset) {
    browsedMonth = shiftMonth(browsedMonth, offset);
    renderCalendar();
  }

  function previousMonth() { moveMonth(-1); }
  function nextMonth() { moveMonth(1); }

  function selectDate(date) {
    if (!available.has(date)) return;
    selected = date;
    valueText.textContent = dateLabel(selected);
    trigger.setAttribute('aria-label', `${label}, ${dateLabel(selected, true)}`);
    onChange(selected);
    closeDialog();
  }

  function handleClick(event) {
    if (event.target === dialog) return closeDialog();
    const button = event.target.closest?.('[data-date]');
    if (button && !button.disabled) selectDate(button.dataset.date);
  }

  function handleKeydown(event) {
    const button = event.target.closest?.('[data-date]');
    if (!button) return;
    const target = keyedDate(button.dataset.date, event.key, available);
    if (!target) return;
    event.preventDefault();
    pendingFocus = target;
    if (monthKey(target) !== browsedMonth) browsedMonth = monthKey(target);
    renderCalendar();
  }

  function handleCancel(event) {
    event.preventDefault();
    closeDialog();
  }

  function restoreFocus() {
    trigger.focus();
  }

  trigger.addEventListener('click', openDialog);
  previous.addEventListener('click', previousMonth);
  next.addEventListener('click', nextMonth);
  dialog.addEventListener('click', handleClick);
  dialog.addEventListener('keydown', handleKeydown);
  dialog.addEventListener('cancel', handleCancel);
  dialog.addEventListener('close', restoreFocus);

  return {
    update({ value = '', dates = [], disabled: nextDisabled = false } = {}) {
      const normalized = normalizeDates(dates);
      const nextSelected = parseDate(value) ? value : '';
      const key = `${nextSelected}|${normalized.join(',')}|${Boolean(nextDisabled)}`;
      if (key === renderedKey) return;
      const valueChanged = nextSelected !== selected;
      selected = nextSelected;
      availableList = normalized;
      available = new Set(normalized);
      disabled = Boolean(nextDisabled);
      renderedKey = key;
      if (!browsedMonth || valueChanged) browsedMonth = monthKey(selected || availableList[0]);
      valueText.textContent = dateLabel(selected);
      trigger.disabled = disabled || !availableList.length;
      trigger.setAttribute('aria-label', `${label}, ${dateLabel(selected, true)}`);
      if (dialog.open) renderCalendar();
    },
    destroy() {
      trigger.removeEventListener('click', openDialog);
      previous.removeEventListener('click', previousMonth);
      next.removeEventListener('click', nextMonth);
      dialog.removeEventListener('click', handleClick);
      dialog.removeEventListener('keydown', handleKeydown);
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', restoreFocus);
      if (dialog.open) dialog.close();
      element.innerHTML = '';
    },
  };
}
