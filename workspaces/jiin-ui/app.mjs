import { demoDate, scenarioOptions } from './sample-data.mjs';
import { mountScenarioTools } from './scenario-tools.mjs';

import { mountDesignGuide } from './design-guide.mjs';
import { pages, pageFromHash, viewModel } from './view-model.mjs';
import { escapeHtml, range, tone, badge, etaLabel, etaValue, etaUpdatedLabel, keyValue, etaCard, customerCard, notificationCard } from './view-components.mjs';

const state = { scenario: 'traffic', selectedId: 'TMS-001', query: '', status: 'all', changedOnly: false, tab: 'events', page: pageFromHash(location.hash) };
const byId = id => document.getElementById(id);

const scenarioTools = mountScenarioTools({
  options: scenarioOptions,
  selected: state.scenario,
  onSelect(scenario) {
    Object.assign(state, { scenario, selectedId: 'TMS-001' });
    clearFilters();
    render({ announce: true });
  },
  onReset() {
    Object.assign(state, { scenario: 'departure', selectedId: 'TMS-001', tab: 'events' });
    clearFilters();
    render({ announce: true, resetPanels: true });
  },
});

function renderList(visible) {
  byId('list-count').textContent = `${visible.length}개`;
  const changed = visible.filter(terminal => terminal.changed).length;
  const check = visible.filter(terminal => ['unknown', 'stale'].includes(terminal.etaStatus)).length;
  byId('summary-counts').innerHTML = `<div><span>${state.page === 'deliveries' ? '조회 배송' : '조회 단말'}</span><strong>${visible.length}</strong></div><div><span>ETA 변경</span><strong>${changed}</strong></div><div><span>ETA 확인 필요</span><strong>${check}</strong></div>`;
  byId('terminal-list').innerHTML = visible.length ? visible.map(terminal => `
    <button type="button" class="terminal-row${state.selectedId === terminal.id ? ' selected' : ''}" data-terminal="${terminal.id}" aria-pressed="${state.selectedId === terminal.id}" aria-label="${escapeHtml(terminal.vehicle)} ${terminal.id} ${terminal.stage} 선택">
      <span class="terminal-row-head"><strong>${terminal.vehicle}</strong>${badge(terminal.stage, tone(terminal))}</span>
      <span class="terminal-row-meta">${terminal.id} <span>·</span> ${terminal.deliveryId}</span>
      <span class="terminal-row-eta">${terminal.etaStatus === 'stale' ? '<span class="muted">마지막 </span>' : ''}${escapeHtml(etaValue(terminal))}</span>
      <span class="terminal-row-meta">${terminal.customer}<span class="row-alert ${terminal.changed || terminal.etaStatus === 'stale' ? 'amber' : ''}">${escapeHtml(terminal.changeText ?? (terminal.etaStatus === 'stale' ? '갱신 확인 필요' : `갱신 ${terminal.updatedAt}`))}</span></span>
    </button>`).join('') : '<div class="empty-state"><strong>조회 결과가 없습니다.</strong><p>검색어나 배송 상태 조건을 바꿔 주세요.</p></div>';
}

function renderEta(terminal) {
  byId('eta-panel').innerHTML = etaCard(terminal, 'eta-heading');
}

function renderDetails(terminal) {
  byId('event-list').innerHTML = terminal.events.map(event => `<li><time class="event-time">${event.at}</time><div class="event-copy"><span class="event-kind">${event.kind}</span><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.detail)}</p></div></li>`).join('');
  byId('notification-list').innerHTML = '<p class="notification-description">표시될 문구를 비교하는 미리보기입니다. 발송·전달·수신 결과가 아닙니다.</p>' + notificationCard(terminal.deviceNotice, 'TMS 장치 알림 예시') + notificationCard(terminal.customerNotice, '고객 안내 예시');
  byId('delivery-information').innerHTML = `
    <dl class="key-values delivery-key-values">${keyValue('차량', terminal.vehicle)}${keyValue('차량 장착 단말', terminal.id)}${keyValue('배송', terminal.deliveryId)}${keyValue('고객 별칭', terminal.customer)}${keyValue('배송 단계', terminal.stage)}${keyValue('실제 도착 시각', terminal.actualArrivalAt ?? '미확인')}${keyValue('배송 완료 시각', terminal.completedAt ?? '미확인')}${keyValue('장치 연결 상태', '미확인')}${keyValue('장치 수신 시각', terminal.deviceReceivedAt ?? '미확인')}</dl>
    <p class="footer-note">한 차량·한 단말·한 배송의 연결은 이번 화면용 합성 예시입니다.</p>`;
}

function renderPreview(terminal, resetPanels) {
  const customerWasOpen = !resetPanels && Boolean(byId('preview-sidebar').querySelector('details')?.open);
  byId('preview-sidebar').innerHTML = `
    <section class="panel device-preview-panel"><div class="panel-heading"><h2>TMS 장치</h2><span class="muted">표시 예시</span></div>
      <div class="device-preview-body"><div class="terminal-screen" aria-label="${terminal.id} 차량 장착형 TMS 표시 예시">
        <div class="terminal-screen-header"><strong>${terminal.id}</strong><span>차량 장착형</span></div>
        <div class="terminal-screen-body"><div class="terminal-stop"><p class="eyebrow">${terminal.deliveryId}</p><h3>${terminal.customer}</h3>${badge(terminal.stage, tone(terminal))}</div>
          <div class="terminal-eta"><span>${etaLabel(terminal)}</span><strong>${escapeHtml(etaValue(terminal))}</strong><small>${etaUpdatedLabel(terminal)}</small></div>
          <div class="terminal-next"><span>현재 계획 순서</span><strong>${terminal.sequence === null ? '미확인' : `${terminal.sequence}번째`}</strong></div>
          ${terminal.deviceNotice ? `<div class="device-alert"><span class="eyebrow">알림 표시 예시</span><p>${escapeHtml(terminal.deviceNotice.title)}</p>${terminal.etaStatus === 'stale' ? '<small>마지막 정보 기준입니다.</small>' : ''}</div>` : ''}
        </div><div class="terminal-screen-footer">시연용 · 실제 장치 화면 수집 아님</div>
      </div>
      <dl class="key-values device-key-values">${keyValue('장치 연결', '미확인')}${keyValue('장치 수신', '미확인')}</dl><p class="footer-note">배송 결과를 배치한 예시입니다. 실제 장치 규격·화면은 미확인입니다.</p></div>
    </section>
    <details class="customer-preview panel" id="customer-preview" tabindex="-1"${customerWasOpen ? ' open' : ''}><summary>고객 안내 미리보기<span aria-hidden="true">+</span></summary>${customerCard(terminal)}</details>`;
}

function renderTabs() {
  byId('detail-panel').querySelectorAll('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === state.tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(`panel-${button.dataset.tab}`).hidden = !selected;
  });
}

function render({ announce = false, resetPanels = false } = {}) {
  const { terminals, visible, selected } = viewModel(state);
  state.selectedId = selected?.id ?? null;
  syncFilters();
  renderPage();
  renderList(visible);
  byId('snapshot-clock').textContent = `${demoDate} · ${terminals[0].snapshotTime} 시연 기준`;
  scenarioTools.update(state.scenario);
  byId('eta-panel').hidden = !selected;
  byId('detail-panel').hidden = !selected;
  if (selected) {
    byId('selected-heading').innerHTML = `<div class="terminal-title"><p class="eyebrow">선택 단말 · ${selected.id}</p><h2>${selected.vehicle}</h2><p>${selected.deliveryId} <span>·</span> ${selected.customer}</p></div><div class="status-meta">${badge(selected.stage, tone(selected))}<span>장치 연결 미확인</span></div>`;
    renderEta(selected);
    renderDetails(selected);
    renderPreview(selected, resetPanels);
  } else {
    byId('selected-heading').innerHTML = '<div class="empty-state"><h2>선택할 단말이 없습니다.</h2><p>조회 조건을 바꾸면 단말 정보를 다시 확인할 수 있습니다.</p><button type="button" class="button" id="clear-filters">조회 조건 초기화</button></div>';
    byId('preview-sidebar').innerHTML = '';
    byId('clear-filters').addEventListener('click', () => { clearFilters(); render({ announce: true }); byId('terminal-search').focus(); });
  }
  renderDeliveries(visible, selected);
  renderCustomerPage(visible, selected);
  renderTabs();
  if (announce) byId('screen-status').textContent = selected ? `${selected.vehicle} ${selected.id} 선택. ${selected.stage}. ${etaLabel(selected)} ${etaValue(selected)}. 배송 정보 갱신 ${selected.updatedAt}.` : '조회 조건에 맞는 단말이 없습니다.';
}

function clearFilters() {
  Object.assign(state, { query: '', status: 'all', changedOnly: false });
  syncFilters();
}
function syncFilters() {
  document.querySelectorAll('[data-query]').forEach(input => { if (input.value !== state.query) input.value = state.query; });
  document.querySelectorAll('[data-status]').forEach(input => { input.value = state.status; });
  document.querySelectorAll('[data-changed]').forEach(input => { input.checked = state.changedOnly; });
}

function renderPage() {
  const page = pages[state.page];
  document.querySelectorAll('[data-page]').forEach(panel => { panel.hidden = panel.dataset.page !== state.page; });
  document.querySelectorAll('[data-page-link]').forEach(link => {
    if (link.dataset.pageLink === state.page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  byId('app-title').textContent = page.title;
  byId('page-heading').textContent = page.title;
  byId('page-eyebrow').textContent = page.eyebrow;
  byId('page-description').textContent = page.description;
  byId('summary-counts').hidden = !['deliveries', 'control'].includes(state.page);
  byId('toggle-map').hidden = state.page !== 'control';
  document.title = `${page.title} · 미트박스 TMS`;
}

function renderDeliveries(visible, selected) {
  byId('delivery-count').textContent = `${visible.length}건`;
  byId('delivery-empty').hidden = visible.length > 0;
  byId('delivery-rows').innerHTML = visible.map(terminal => `
    <tr class="${terminal.id === state.selectedId ? 'selected' : ''}"><td><button type="button" class="delivery-select" data-delivery="${terminal.id}" aria-pressed="${terminal.id === state.selectedId}"><strong>${terminal.deliveryId}</strong><span>${terminal.customer}</span></button></td><td>${badge(terminal.stage, tone(terminal))}</td><td><strong>${terminal.etaStatus === 'stale' ? '마지막 ' : ''}${etaValue(terminal)}</strong><small>${etaUpdatedLabel(terminal)}</small></td><td>${terminal.vehicle}<small>${terminal.id}</small></td><td>${terminal.changed ? badge(terminal.changeText, 'amber') : terminal.etaStatus === 'stale' ? badge('갱신 확인 필요', 'amber') : '—'}</td></tr>`).join('');
  byId('delivery-selection').innerHTML = selected ? `<div class="panel-heading"><h2>선택 배송</h2>${badge(selected.stage, tone(selected))}</div><div class="selection-body"><p class="eyebrow">${selected.deliveryId} · ${selected.id}</p><h3>${selected.customer}</h3><p class="eyebrow">${etaLabel(selected)}</p><strong class="selection-eta">${etaValue(selected)}</strong><p class="muted">${etaUpdatedLabel(selected)}</p><dl class="key-values">${keyValue('차량', selected.vehicle)}${keyValue('변경 사유', selected.reason ?? '별도 변경 없음')}</dl><div class="selection-actions"><a class="button primary" href="#/control">단말 관제 보기</a><a class="button" href="#/customer">고객 보기</a></div></div>` : '<div class="empty-state"><h2>선택할 배송이 없습니다.</h2><p>조회 조건을 바꾸면 배송을 선택할 수 있습니다.</p></div>';
}

function renderCustomerPage(visible, selected) {
  const select = byId('customer-delivery');
  select.disabled = !selected;
  select.innerHTML = visible.length ? visible.map(terminal => `<option value="${terminal.id}">${terminal.deliveryId} · ${terminal.customer}</option>`).join('') : '<option>조회된 배송 없음</option>';
  if (selected) select.value = selected.id;
  byId('customer-context').innerHTML = selected ? `<dl class="key-values customer-context-values">${keyValue('차량 · 단말', `${selected.vehicle} · ${selected.id}`)}${keyValue('안내 기준', `${selected.updatedAt} · 한국 시간`)}${keyValue('현재 단계', selected.stage)}</dl><p class="footer-note">선택한 배송은 배송 현황과 단말 관제에도 함께 반영됩니다.</p>` : '<div class="empty-state"><strong>선택할 배송이 없습니다.</strong><p>배송 목록에서 조회 조건을 바꿔 주세요.</p></div>';
  byId('customer-display').innerHTML = selected ? `<section class="panel customer-surface" aria-label="${selected.deliveryId} 고객 안내 미리보기"><div class="customer-surface-header"><strong>미트박스</strong><span>배송 안내</span></div>${customerCard(selected)}</section><p class="footer-note customer-surface-note">고객 안내 화면 예시 · 가상 배송 데이터</p>` : '<section class="panel empty-state"><h2>고객 안내를 표시할 배송이 없습니다.</h2><p>조회 조건을 초기화하거나 배송 목록으로 이동해 주세요.</p><button type="button" class="button" data-clear-filters>조회 조건 초기화</button></section>';
}

window.addEventListener('hashchange', () => {
  state.page = pageFromHash(location.hash);
  if (location.hash !== `#/${state.page}`) history.replaceState(null, '', `#/${state.page}`);
  render();
  byId('page-heading').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); byId('page-heading').focus(); });
document.querySelectorAll('[data-query]').forEach(input => input.addEventListener('input', event => { state.query = event.target.value; render({ announce: true }); }));
document.querySelectorAll('[data-status]').forEach(input => input.addEventListener('change', event => { state.status = event.target.value; render({ announce: true }); }));
document.querySelectorAll('[data-changed]').forEach(input => input.addEventListener('change', event => { state.changedOnly = event.target.checked; render({ announce: true }); }));
document.addEventListener('click', event => { if (!event.target.closest('[data-clear-filters]')) return; clearFilters(); render({ announce: true }); });
byId('delivery-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-delivery]');
  if (!button) return;
  state.selectedId = button.dataset.delivery;
  render({ announce: true });
  byId('delivery-rows').querySelector(`[data-delivery="${state.selectedId}"]`).focus({ preventScroll: true });
});
byId('customer-delivery').addEventListener('change', event => { state.selectedId = event.target.value; render({ announce: true }); });

byId('terminal-list').addEventListener('click', event => {
  const button = event.target.closest('[data-terminal]');
  if (!button) return;
  state.selectedId = button.dataset.terminal;
  render({ announce: true });
  document.querySelector(`[data-terminal="${state.selectedId}"]`).focus({ preventScroll: true });
});
byId('toggle-map').addEventListener('click', event => {
  const expanded = event.currentTarget.getAttribute('aria-expanded') !== 'true';
  byId('map-preview').hidden = !expanded;
  event.currentTarget.setAttribute('aria-expanded', String(expanded));
  event.currentTarget.textContent = expanded ? '지도 접기' : '지도 펼치기';
});
const tabs = [...byId('detail-panel').querySelectorAll('[data-tab]')];
tabs.forEach((button, index) => {
  button.addEventListener('click', () => { state.tab = button.dataset.tab; renderTabs(); });
  button.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    state.tab = tabs[next].dataset.tab;
    renderTabs();
    tabs[next].focus();
  });
});

mountDesignGuide(byId('page-design'));
new ResizeObserver(() => document.documentElement.style.setProperty('--header-height', `${document.querySelector('.app-header').offsetHeight}px`)).observe(document.querySelector('.app-header'));
history.replaceState(null, '', `#/${state.page}`);
render();
