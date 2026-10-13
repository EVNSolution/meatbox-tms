export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const range = eta => eta ? `${eta.start} ~ ${eta.end}` : '확인 중';
export const tone = terminal => terminal.status === 'completed' ? 'green' : terminal.status === 'in_transit' ? 'blue' : 'neutral';
export const badge = (text, color = 'neutral') => `<span class="badge ${color}">${escapeHtml(text)}</span>`;
export const etaLabel = terminal => terminal.status === 'completed' ? '배송 완료 시각' : terminal.etaStatus === 'stale' ? '마지막 도착 예정 시간' : '도착 예정 시간';
export const etaValue = terminal => terminal.status === 'completed' ? `${terminal.completedAt ?? '시각 미확인'}${terminal.completedAt ? ' 완료' : ''}` : range(terminal.eta);
export const etaUpdatedLabel = terminal => terminal.status === 'completed' ? `완료 정보 갱신 ${terminal.updatedAt}` : terminal.eta ? `마지막 ETA 갱신 ${terminal.eta.updatedAt}` : 'ETA 미확정';
export const keyValue = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

export function etaCard(terminal, headingId) {
  const lastUpdated = terminal.eta?.updatedAt ?? null;
  const timeCaption = terminal.status === 'completed' ? '완료 처리 기준' : lastUpdated ? `ETA 갱신 ${lastUpdated}` : 'ETA 미확정';
  const previous = terminal.previousEta ? `<p class="eta-previous">이전 <span>${range(terminal.previousEta)}</span></p>` : '';
  const notice = terminal.etaStatus === 'stale'
    ? `<div class="notice warning"><strong>최신 정보 확인이 필요합니다.</strong><p>${terminal.snapshotTime} 갱신 실패 표본입니다. 마지막 ETA는 ${lastUpdated} 기준이며 새 예측이 아닙니다.</p></div>`
    : terminal.etaStatus === 'unknown'
      ? '<div class="notice neutral">도착 예정 시간이 아직 제공되지 않았습니다.</div>'
      : terminal.status === 'completed'
        ? '<div class="notice neutral">배송 완료 시각과 실제 도착 시각은 별도 정보입니다. 실제 도착 시각은 미확인입니다.</div>'
        : '';
  return `
    <div class="panel-heading"><h2 class="inline-meta" id="${escapeHtml(headingId)}"><span>ETA</span><span class="meta-separator"> · </span><span>배송 진행</span></h2><span class="muted">배송 정보 갱신 ${terminal.updatedAt}</span></div>
    <div class="eta-grid">
      <div class="eta-primary"><p class="eyebrow">${etaLabel(terminal)}</p><p class="eta-value${!terminal.eta && terminal.status !== 'completed' ? ' is-unknown' : ''}">${escapeHtml(etaValue(terminal))}</p><p class="muted inline-meta"><span>9월 16일</span><span class="meta-separator"> · </span><span>한국 시간</span><span class="meta-separator"> · </span><span>${timeCaption}</span></p>${previous}</div>
      <div class="eta-secondary"><dl class="key-values">${keyValue('현재 단계', terminal.stage)}${keyValue('현재 계획 순서', terminal.sequence === null ? '미확인' : `${terminal.sequence}번째`)}${keyValue('실제 도착', terminal.actualArrivalAt ?? '미확인')}</dl></div>
    </div>
    <div class="eta-panel-foot"><div class="reason-line">${terminal.changed ? badge(terminal.changeText, 'amber') : terminal.nearby ? badge('인근 배송 중', 'blue') : badge(terminal.status === 'completed' ? '완료' : '상태 표본', tone(terminal))}<span>${escapeHtml(terminal.reason ?? (terminal.nearby ? '합성 인근 사건 · 거리 정보 없음' : terminal.status === 'completed' ? '배송 완료 결과' : '현재 배송 결과 기준'))}</span></div>${notice}</div>`;
}

export function notificationCard(notice, label) {
  if (!notice) return `<section class="notification-item"><div class="notification-labels">${badge(label)}</div><div class="empty-state compact"><strong>안내 표본이 지정되지 않았습니다.</strong><p>이 표본에서 알림이 발생한다고 가정하지 않습니다.</p></div></section>`;
  return `<section class="notification-item"><div class="notification-labels">${badge(label)}<span class="muted inline-meta"><span>${notice.at} 표본</span><span class="meta-separator"> · </span><span>수신 여부 미확인</span></span></div><h3>${escapeHtml(notice.title)}</h3><p class="notification-copy">${escapeHtml(notice.body)}</p></section>`;
}

export function customerCard(terminal) {
  return `<div class="customer-card"><p class="eyebrow inline-meta"><span>${terminal.deliveryId}</span><span class="meta-separator"> · </span><span>${terminal.customer}</span></p>${badge(terminal.stage, tone(terminal))}<h3>${terminal.status === 'completed' ? '배송이 완료되었습니다.' : terminal.etaStatus === 'stale' ? '최신 도착 시간 확인 중' : terminal.etaStatus === 'unknown' ? '도착 예정 시간 확인 중' : '상품이 배송 중입니다.'}</h3><p class="eyebrow">${etaLabel(terminal)}</p><strong class="customer-eta">${escapeHtml(etaValue(terminal))}</strong><p class="muted inline-meta"><span>${etaUpdatedLabel(terminal)}</span><span class="meta-separator"> · </span><span>한국 시간</span></p>${terminal.customerNotice ? `<p class="customer-message">${escapeHtml(terminal.customerNotice.body)}</p>` : '<p class="customer-message">별도 안내 문구는 아직 지정되지 않았습니다.</p>'}<p class="footer-note inline-meta"><span>고객 안내 예제</span><span class="meta-separator"> · </span><span>가상 데이터</span></p></div>`;
}
