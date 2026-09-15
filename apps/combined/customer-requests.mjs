const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

const icons = {
  refrigerator: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M5 10h14M8 6v2m0 5v3"/>',
  doorstep: '<path d="M5 21V3h14v18M9 7h6v14M13.5 14.5h.01"/>',
  handoff: '<path d="M4 13h4l2 2h4l2-2h4M7 13V9a5 5 0 0 1 10 0v4M12 4V2"/>',
};

const requestIcon = kind => `<svg class="customer-request-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind] || icons.handoff}</svg>`;
const requests = stop => Array.isArray(stop?.customerRequests?.items) ? stop.customerRequests.items : null;

export function requiredRequestIds(stop) {
  return (requests(stop) || []).filter(item => item.required).map(item => item.id);
}

export function requestsConfirmed(stop, ids = []) {
  const checked = new Set(ids);
  return requiredRequestIds(stop).every(id => checked.has(id));
}

export function renderCustomerRequests(stop, { compact = false, confirmation = false, checkedIds = [] } = {}) {
  const items = requests(stop);
  if (compact) {
    if (!items?.length) return '';
    const example = stop.customerRequests.source === 'example';
    const label = `${example ? '예시 요청' : '고객 요청'}: ${items.map(item => item.label).join(', ')}`;
    return `<span class="customer-requests-compact" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${items.map(item => requestIcon(item.kind)).join('')}<span>${example ? '예시 요청 ' : ''}${items.length}</span></span>`;
  }
  if (items === null) return '<section class="customer-requests customer-requests-empty"><p class="customer-requests-heading">고객 요청</p><strong>정보 미수신</strong><p>고객 요청 데이터가 연결되지 않았습니다.</p></section>';
  if (items.length === 0) return '<section class="customer-requests customer-requests-empty"><p class="customer-requests-heading">고객 요청</p><strong>요청 없음</strong><p>이 배송지에 등록된 고객 요청이 없습니다.</p></section>';
  const checked = new Set(checkedIds);
  const content = items.map(item => confirmation
    ? `<label class="customer-request-check"><input type="checkbox" data-request-check="${escapeHtml(item.id)}" ${checked.has(item.id) ? 'checked' : ''}><span class="customer-request-symbol">${requestIcon(item.kind)}</span><span><strong>${escapeHtml(item.label)}</strong>${item.required ? '<small>필수 확인</small>' : ''}</span></label>`
    : `<li><span class="customer-request-symbol">${requestIcon(item.kind)}</span><span><strong>${escapeHtml(item.label)}</strong>${item.required ? '<small>필수 요청</small>' : ''}</span></li>`).join('');
  return `<section class="customer-requests${confirmation ? ' customer-requests-confirmation' : ''}"><header><p class="customer-requests-heading">고객 요청</p>${stop.customerRequests.source === 'example' ? '<span class="customer-requests-example">예시 요청</span>' : ''}</header>${confirmation ? `<div class="customer-request-checks">${content}</div>` : `<ul>${content}</ul>`}</section>`;
}
