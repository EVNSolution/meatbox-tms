import { calendarMonth } from './date-picker.mjs';

const weekdays = ['일', '월', '화', '수', '목', '금', '토'];

export function shiftHistoryMonth(date, offset) {
  const [year, month, day] = date.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

export function renderDriverHistoryCalendar(selectedDate, dates, today, source = false) {
  const model = calendarMonth(selectedDate.slice(0, 7), dates, selectedDate);
  const cells = [
    ...Array.from({ length: model.leading }, () => '<td></td>'),
    ...model.days.map(day => {
      const weekday = weekdays[(model.leading + day.day - 1) % 7];
      const label = `${day.date.replaceAll('-', '.')} ${weekday}요일${day.available ? source ? ', 배차 자료 있음' : ', 예시 배차 있음' : ''}`;
      return `<td><button type="button" class="dv-calendar-day" data-history-date="${day.date}" data-focus="history-${day.date}" aria-label="${label}" aria-pressed="${day.selected}"${day.date === today ? ' aria-current="date"' : ''}><span>${day.day}</span>${day.available ? '<i aria-hidden="true"></i>' : ''}</button></td>`;
    }),
  ];
  while (cells.length % 7) cells.push('<td></td>');
  const rows = Array.from({ length: cells.length / 7 }, (_, index) => `<tr>${cells.slice(index * 7, index * 7 + 7).join('')}</tr>`).join('');
  return `<section class="dv-history-calendar" aria-label="과거 배차 달력">
    <header><button type="button" class="dv-calendar-month" data-history-month="-1" data-focus="history-previous" aria-label="과거 배차 이전 달">‹</button><h3 aria-live="polite">${model.title}</h3><button type="button" class="dv-calendar-month" data-history-month="1" data-focus="history-next" aria-label="과거 배차 다음 달">›</button></header>
    <table aria-label="${model.title} 과거 배차"><thead><tr>${weekdays.map(day => `<th scope="col">${day}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <p class="dv-calendar-legend"><i aria-hidden="true"></i>${source ? '배차 기록이 있는 날' : '예시 배차가 있는 날'}</p>
  </section>`;
}
