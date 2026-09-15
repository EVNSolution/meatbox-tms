const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

const icons = {
  refrigerator: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M5 10h14M8 6v2m0 5v3"/>',
  doorstep: '<path d="M4 21V3h13v18M4 3l9 3v15M10 12h.01M2 21h20"/><path d="M17 16h4v5h-4"/>',
  indoor: '<path d="m3 10 9-7 9 7M5 9v12h14V9"/><rect x="9" y="13" width="6" height="6" rx="1"/><path d="M12 13v2"/>',
  handoff: '<circle cx="7" cy="6" r="3"/><path d="M2 20v-5a5 5 0 0 1 10 0v1h3"/><rect x="15" y="11" width="7" height="7" rx="1"/><path d="M18.5 11v2"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
};

const requestIcon = kind => `<svg class="customer-request-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${Object.hasOwn(icons, kind) ? icons[kind] : icons.unknown}</svg>`;
const requests = stop => Array.isArray(stop?.customerRequests?.items) ? stop.customerRequests.items : null;

export function requiredRequestIds(stop) {
  return (requests(stop) || []).filter(item => item.required).map(item => item.id);
}

export function requestsConfirmed(stop, ids = []) {
  const checked = new Set(ids);
  return requiredRequestIds(stop).every(id => checked.has(id));
}

export function renderCustomerRequests(stop, { compact = false, confirmation = false, checkedIds = [], showSource = true } = {}) {
  const items = requests(stop);
  if (compact) {
    if (!items?.length) return '';
    return `<span class="customer-requests-compact" role="group" aria-label="고객 요청">${items.map(item => `<button type="button" class="customer-request-badge" data-request-info="${escapeHtml(item.id)}" data-focus="request-${escapeHtml(item.id)}" aria-label="${escapeHtml(item.label)} 요청 내용 보기" aria-haspopup="dialog" title="${escapeHtml(item.label)}">${requestIcon(item.kind)}</button>`).join('')}</span>`;
  }
  if (items === null) return '<section class="customer-requests customer-requests-empty"><p class="customer-requests-heading">고객 요청</p><strong>정보 미수신</strong><p>고객 요청 데이터가 연결되지 않았습니다.</p></section>';
  if (items.length === 0) return '<section class="customer-requests customer-requests-empty"><p class="customer-requests-heading">고객 요청</p><strong>요청 없음</strong><p>이 배송지에 등록된 고객 요청이 없습니다.</p></section>';
  const checked = new Set(checkedIds);
  const content = items.map(item => confirmation
    ? `<label class="customer-request-check"><input type="checkbox" data-request-check="${escapeHtml(item.id)}" ${checked.has(item.id) ? 'checked' : ''}><span class="customer-request-symbol">${requestIcon(item.kind)}</span><span><strong>${escapeHtml(item.label)}</strong>${item.required ? '<small>필수 확인</small>' : ''}</span></label>`
    : `<li><span class="customer-request-symbol">${requestIcon(item.kind)}</span><span><strong>${escapeHtml(item.label)}</strong>${item.required ? '<small>필수 요청</small>' : ''}</span></li>`).join('');
  return `<section class="customer-requests${confirmation ? ' customer-requests-confirmation' : ''}"><header><p class="customer-requests-heading">고객 요청</p>${showSource && stop.customerRequests.source === 'example' ? '<span class="customer-requests-example">예시 요청</span>' : ''}</header>${confirmation ? `<div class="customer-request-checks">${content}</div>` : `<ul>${content}</ul>`}</section>`;
}
