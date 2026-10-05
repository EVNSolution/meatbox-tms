import { dateSummaryToolbar, mountDateSummaryToolbar } from '../combined/date-summary-toolbar.mjs';
import { mountDatePicker } from '../combined/date-picker.mjs';
import { referenceIcon } from '../combined/reference-icons.mjs';
import { badge, customerCard, escapeHtml, etaCard, notificationCard } from './view-components.mjs';

const baseSample = Object.freeze({
  id: 'DESIGN-01', vehicle: '11가 1111', deliveryId: '주문 2026-001', customer: '미트박스 매장',
  stage: '배송 중', status: 'in_transit', etaStatus: 'current', eta: { start: '10:20', end: '10:30', updatedAt: '10:05' },
  previousEta: null, updatedAt: '10:05', snapshotTime: '10:05', sequence: 2, actualArrivalAt: null,
  changed: false, nearby: false, reason: '현재 배차 기준', events: [
    { at: '09:40', kind: '배차', title: '배차 확정', detail: '운영 배차가 확정되었습니다.' },
    { at: '10:05', kind: 'ETA', title: '도착 예정 시간 갱신', detail: '현재 배차 기준 시간이 반영되었습니다.' },
  ],
  customerNotice: { at: '10:05', title: '배송 안내', body: '도착 예정 시간을 확인해 주세요.' },
});
const samples = {
  departure: baseSample,
  traffic: { ...baseSample, eta: { start: '10:30', end: '10:40', updatedAt: '10:08' }, previousEta: baseSample.eta, updatedAt: '10:08', changed: true, changeText: 'ETA 변경', reason: '교통 상황 반영' },
  preparing: { ...baseSample, stage: '출고 준비', status: 'preparing', etaStatus: 'unknown', eta: null, sequence: null, reason: '배차 계산 대기' },
  stale: { ...baseSample, etaStatus: 'stale', updatedAt: '10:20', snapshotTime: '10:20', reason: '최신 정보 확인 필요' },
  completed: { ...baseSample, stage: '배송 완료', status: 'completed', eta: null, completedAt: '10:24', updatedAt: '10:24', reason: '배송 완료 결과' },
};
const sample = name => samples[name];

function token(label, property, className = '') {
  return `<li><span class="design-guide-token-swatch ${className}" aria-hidden="true"></span><span><strong>${label}</strong><small data-theme-token="${property}"></small></span></li>`;
}

function etaSample(title, stateName) {
  const terminal = sample(stateName);
  const headingId = `design-guide-eta-${stateName}`;
  return `<article class="design-guide-eta-sample"><p class="design-guide-sample-label">${title}</p><section class="panel" aria-labelledby="${headingId}">${etaCard(terminal, headingId)}</section></article>`;
}

// Guide examples are local and never use a client or API.
function mountDateToolbarSample(container) {
  const today = '2026-09-16';
  const fixtures = {
    '2026-09-14': [['차량', 8], ['배송', 24], ['완료', 24]],
    '2026-09-15': [],
    [today]: [['차량', 8], ['배송', 24], ['완료', 5]],
  };
  const toolbar = container.querySelector('[data-guide-date-toolbar]');
  const summary = mountDateSummaryToolbar(toolbar);
  const status = toolbar.querySelector('[data-guide-date-mode]');
  const todayButton = toolbar.querySelector('[data-guide-today]');
  const feedback = container.querySelector('[data-guide-date-feedback]');
  let picker;
  function select(value) {
    const counts = fixtures[value];
    if (counts.length) summary.update(counts);
    else summary.clear();
    status.textContent = value === today ? '컴포넌트 예제' : counts.length ? '이력 조회 · 읽기 전용' : '자료 없음';
    feedback.textContent = `${value} 예제${counts.length ? ' 수량입니다.' : '에는 자료가 없어 수량을 숨깁니다.'} 실제 조회·배차 상태는 변경하지 않습니다.`;
    todayButton.disabled = value === today;
    picker.update({ value, dates: Object.keys(fixtures) });
  }
  picker = mountDatePicker({ element: toolbar.querySelector('[data-guide-datepicker]'), label: '가이드 날짜 선택', onChange: select });
  todayButton.addEventListener('click', () => select(today));
  select(today);
}

function mountTabSample(container) {
  const tabs = [...container.querySelectorAll('[data-guide-tab]')];
  const select = selectedTab => {
    tabs.forEach(tab => {
      const selected = tab === selectedTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      container.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
    });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      let next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (direction) next = tabs[(index + direction + tabs.length) % tabs.length];
      if (!next) return;
      event.preventDefault();
      select(next);
      next.focus();
    });
  });
}

export function mountDesignGuide(container) {
  if (container.dataset.mounted === 'true') return;

  const changed = sample('traffic');
  const events = changed.events.slice(-2);

  container.classList.add('design-guide');
  container.innerHTML = `
    <section class="design-guide-section panel" aria-labelledby="design-guide-product">
      <div class="panel-heading"><div><p class="eyebrow">현행 제품 구성</p><h2 id="design-guide-product">업무와 화면의 역할</h2></div><span class="muted">운영 기준</span></div>
      <div class="design-guide-panel-body design-guide-navigation">
        <nav class="guide-product-navigation" aria-label="현행 운영 화면 링크"><a href="/combined/#/orders">배차 관리</a><a href="/combined/#/control">배송 관제</a><a href="/combined/#/deliveries">자원 관리</a></nav>
        <div><p>운영 화면은 날짜별 배차와 배송 관제, 날짜 없는 차량 등록부로 나눕니다.</p><p class="muted">이 페이지의 값은 시각 기준을 검토하기 위한 고정 예제이며 운영 자료를 읽거나 변경하지 않습니다.</p></div>
      </div>
    </section>

    <section class="design-guide-section panel" aria-labelledby="design-guide-brand">
      <div class="panel-heading"><div><p class="eyebrow">보존한 공식 자산</p><h2 id="design-guide-brand">로고 · 앱 · 기능 아이콘</h2></div><span class="muted">서로 다른 역할</span></div>
      <div class="design-guide-panel-body design-guide-brand-assets">
        <div class="guide-brand-lockup"><img src="/combined/assets/meatbox-logo.svg" width="126" height="30" alt="미트박스"><span>TMS</span></div>
        <div class="guide-app-icon"><img src="/combined/assets/meatbox-app.webp" width="48" height="48" alt="미트박스 앱 아이콘"><span>앱 아이콘</span></div>
        <p class="muted">원본 로고의 형태와 색을 유지합니다. 기능 아이콘은 조작의 의미를 나타냅니다.</p>
        <ul class="guide-icon-samples" aria-label="공통 기능 아이콘 표본">${[['search', '검색'], ['location', '위치'], ['truck', '배송'], ['bell', '알림'], ['user', '사용자'], ['support', '지원'], ['close', '닫기'], ['next', '다음']].map(([name, label]) => `<li>${referenceIcon(name)}<span>${label}</span></li>`).join('')}</ul>
      </div>
    </section>

    <section class="design-guide-section panel" aria-labelledby="design-guide-foundations">
      <div class="panel-heading"><div><p class="eyebrow">제품 공통 테마</p><h2 id="design-guide-foundations">시각 기본 규칙</h2></div><span class="muted">공통 토큰</span></div>
      <div class="design-guide-foundations">
        <ul class="design-guide-tokens" aria-label="주요 색상 토큰">
          ${token('주 액션', '--action', 'is-action')}
          ${token('브랜드 선택', '--brand', 'is-brand')}
          ${token('보조 액센트', '--accent', 'is-accent')}
          ${token('작업 영역', '--workspace', 'is-workspace')}
          ${token('구분선', '--border', 'is-border')}
        </ul>
        <div class="design-guide-type" aria-label="타이포와 간격 표본">
          <p class="design-guide-title-sample">Pretendard · 제목 24px</p><p class="muted">기본 반경 6px · 조작 44px · 헤더 56px</p>
          <p class="design-guide-body-sample"><span>본문 14px</span><span>배송 상태와 시간을 빠르게 읽는 밀도</span></p>
          <p class="muted design-guide-caption-sample"><span>보조 정보 12px</span><span>갱신 시각과 표본 경계</span></p>
          <div class="design-guide-spacing" aria-label="간격 기준 4, 8, 12, 16, 24픽셀"><i></i><i></i><i></i><i></i><i></i></div>
        </div>
      </div>
    </section>

    <section class="design-guide-section panel" aria-labelledby="design-guide-controls">
      <div class="panel-heading"><div><p class="eyebrow">기본 UI</p><h2 id="design-guide-controls">입력과 선택</h2></div><span class="muted">직접 조작 가능</span></div>
      <div class="design-guide-controls">
        <div class="design-guide-control-group">
          <h3>버튼 상태</h3>
          <div class="design-guide-inline"><button type="button" class="button primary">주요 액션</button><button type="button" class="button">보조 액션</button><button type="button" class="button subtle">낮은 강조</button><button type="button" class="button" disabled>비활성</button></div>
          <p class="footer-note">Tab 키로 실제 focus 표시를 확인할 수 있습니다.</p>
        </div>
        <div class="design-guide-control-group">
          <h3>조회 입력</h3>
          <div class="design-guide-field-row"><label><span>배송 검색</span><input type="search" placeholder="배송 또는 차량 검색" autocomplete="off"></label><label><span>상태 필터</span><select><option>전체 상태</option><option>배송 중</option><option>ETA 확인 필요</option><option>배송 완료</option></select></label></div>
        </div>
        <div class="design-guide-control-group design-guide-control-wide">
          <h3>탭과 배지 상태</h3>
          <div class="detail-tabs" role="tablist" aria-label="디자인 가이드 탭 표본"><button type="button" role="tab" id="design-guide-tab-one" aria-selected="true" aria-controls="design-guide-panel-one" data-guide-tab>정상 선택</button><button type="button" role="tab" id="design-guide-tab-two" aria-selected="false" aria-controls="design-guide-panel-two" tabindex="-1" data-guide-tab>다른 탭</button><button type="button" role="tab" id="design-guide-tab-disabled" aria-selected="false" aria-controls="design-guide-panel-disabled" tabindex="-1" disabled>비활성</button></div>
          <div class="design-guide-tab-panel" role="tabpanel" id="design-guide-panel-one" aria-labelledby="design-guide-tab-one"><span>선택된 탭 표본</span></div>
          <div class="design-guide-tab-panel" role="tabpanel" id="design-guide-panel-two" aria-labelledby="design-guide-tab-two" hidden><span>키보드 방향키로도 이동할 수 있습니다.</span></div>
          <div class="design-guide-tab-panel" role="tabpanel" id="design-guide-panel-disabled" aria-labelledby="design-guide-tab-disabled" hidden><span>비활성 탭 표본</span></div>
          <div class="design-guide-inline design-guide-badges" aria-label="배지 색상 비교">${badge('배송 중', 'blue')}${badge('배송 완료', 'green')}${badge('ETA 변경', 'amber')}${badge('미확정', 'neutral')}</div>
        </div>
      </div>
    </section>

    <section class="design-guide-section panel" aria-labelledby="design-guide-date">
      <div class="panel-heading"><div><p class="eyebrow">실제 제품 컴포넌트</p><h2 id="design-guide-date">날짜와 집계</h2></div><span class="muted">예제 날짜 · 로컬 조작</span></div>
      <div class="design-guide-panel-body guide-toolbar-sample">
        ${dateSummaryToolbar({ label: '날짜·집계 예제', actions: '<span>조회 날짜</span><div data-guide-datepicker></div><button class="button" type="button" data-guide-today>오늘 예제</button>', summaryLabel: '수량 예제', context: '<span class="badge neutral" data-guide-date-mode></span>', attributes: 'data-guide-date-toolbar' })}
        <p class="footer-note" data-guide-date-feedback role="status"></p>
        <p class="footer-note">9월 14일은 읽기 전용, 15일은 빈 날짜, 16일은 현재 날짜 표본입니다. 날짜 조작과 상태·집계는 별도 영역에서 상단을 맞춥니다.</p>
      </div>
    </section>

    <section class="design-guide-section" aria-labelledby="design-guide-eta-states">
      <div class="design-guide-section-heading"><div><p class="eyebrow">ETA 상태 예제</p><h2 id="design-guide-eta-states">상태 비교</h2></div><p class="muted">운영 화면의 상태와 문구</p></div>
      <div class="design-guide-eta-grid">
        ${etaSample('기본', 'departure')}
        ${etaSample('변경', 'traffic')}
        ${etaSample('미확정', 'preparing')}
        ${etaSample('갱신 실패', 'stale')}
        ${etaSample('완료', 'completed')}
      </div>
    </section>

    <section class="design-guide-domain-grid" aria-label="상세 구성 요소 비교">
      <section class="panel" aria-labelledby="design-guide-events">
        <div class="panel-heading"><div><p class="eyebrow">상세 예제</p><h2 id="design-guide-events">사건 이력</h2></div>${badge('표시 예제', 'neutral')}</div>
        <div class="design-guide-panel-body"><ol class="timeline">${events.map(event => `<li><time class="event-time">${escapeHtml(event.at)}</time><div class="event-copy"><span class="event-kind">${escapeHtml(event.kind)}</span><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.detail)}</p></div></li>`).join('')}</ol></div>
      </section>
      <section class="panel" aria-labelledby="design-guide-notice">
        <div class="panel-heading"><div><p class="eyebrow">문구 표본</p><h2 id="design-guide-notice">알림 미리보기</h2></div>${badge('수신 미확인', 'amber')}</div>
        <div class="design-guide-panel-body">${notificationCard(changed.customerNotice, '고객 안내 예시')}<p class="footer-note">표시할 문구를 비교하며 실제 발송·전달·수신 결과가 아닙니다.</p></div>
      </section>
      <section class="panel design-guide-customer" aria-labelledby="design-guide-customer">
        <div class="panel-heading"><div><p class="eyebrow">공통 고객 카드</p><h2 id="design-guide-customer">고객 안내</h2></div><span class="muted">1개 배송</span></div>
        <div class="design-guide-panel-body">${customerCard(changed)}</div>
      </section>
    </section>

    <aside class="notice neutral design-guide-review-note" aria-label="디자인 가이드 검토 메모"><strong>디자인 참조 예제</strong><p>이 가이드는 실제 조회·장치 연결·알림 발송 결과가 아닙니다. 공통 테마와 운영 컴포넌트의 시각 상태만 확인합니다.</p></aside>`;

  const theme = getComputedStyle(container);
  container.querySelectorAll('[data-theme-token]').forEach(element => {
    element.textContent = theme.getPropertyValue(element.dataset.themeToken).trim();
  });
  mountDateToolbarSample(container);
  mountTabSample(container);
  container.dataset.mounted = 'true';
}
