export function dateSummaryToolbar({ label, actions, actionsClass = '', summaryLabel, attributes = '' }) {
  return `<section class="date-summary-toolbar" ${attributes} aria-label="${label}"><div class="date-summary-actions${actionsClass ? ` ${actionsClass}` : ''}">${actions}</div><div class="summary-counts" data-date-summary hidden aria-label="${summaryLabel}"></div></section>`;
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
