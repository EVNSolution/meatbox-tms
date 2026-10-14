import { referenceIcon } from './reference-icons.mjs';

export function dateSummaryToolbar({ label, actions, actionsClass = '', summaryLabel, context = '', attributes = '' }) {
  return `<section class="date-summary-toolbar" ${attributes} aria-label="${label}"><div class="date-summary-actions${actionsClass ? ` ${actionsClass}` : ''}">${actions}</div><div class="date-summary-meta">${context}<div class="summary-counts" data-date-summary hidden aria-label="${summaryLabel}"></div></div></section>`;
}

export function mountDateSummaryToolbar(element) {
  const summary = element.querySelector('[data-date-summary]');
  return {
    clear() { summary.hidden = true; summary.innerHTML = ''; },
    update(items) {
      summary.innerHTML = items.map(([label, value]) => `<div><span>${label}</span><strong>${value.toLocaleString('ko-KR')}</strong></div>`).join('');
      summary.hidden = false;
    },
  };
}

export function dateNavActions(label, pickerAttributes) {
  return `<span>${label}</span><button type="button" class="button subtle date-step date-step-prev" data-date-prev aria-label="이전 날짜">${referenceIcon('next')}</button><div ${pickerAttributes}></div><button type="button" class="button subtle date-step" data-date-next aria-label="다음 날짜">${referenceIcon('next')}</button><button type="button" class="button subtle" data-date-today>오늘</button>`;
}
