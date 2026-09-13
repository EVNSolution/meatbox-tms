import { getTerminalSnapshots } from './sample-data.mjs';
import { badge, customerCard, escapeHtml, etaCard, notificationCard } from './view-components.mjs';

const sample = scenario => getTerminalSnapshots(scenario)[0];

function token(label, value, className = '') {
  return `<li><span class="design-guide-token-swatch ${className}" aria-hidden="true"></span><span><strong>${label}</strong><small>${value}</small></span></li>`;
}

function etaSample(title, scenario) {
  const terminal = sample(scenario);
  const headingId = `design-guide-eta-${scenario}`;
  return `<article class="design-guide-eta-sample"><p class="design-guide-sample-label">${title}</p><section class="panel" aria-labelledby="${headingId}">${etaCard(terminal, headingId)}</section></article>`;
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
    <section class="design-guide-section panel" aria-labelledby="design-guide-foundations">
      <div class="panel-heading"><div><p class="eyebrow">B안 운영 밀도 중심</p><h2 id="design-guide-foundations">시각 기본 규칙</h2></div><span class="muted">공통 토큰</span></div>
      <div class="design-guide-foundations">
        <ul class="design-guide-tokens" aria-label="주요 색상 토큰">
          ${token('주 액션', '#263345', 'is-action')}
          ${token('브랜드 강조', '#DB0E64', 'is-brand')}
          ${token('작업 영역', '#F3F4F6', 'is-workspace')}
          ${token('구분선', '#DCE0E6', 'is-border')}
        </ul>
        <div class="design-guide-type" aria-label="타이포와 간격 표본">
          <p class="design-guide-title-sample">페이지 제목 24px</p>
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

    <section class="design-guide-section" aria-labelledby="design-guide-eta-states">
      <div class="design-guide-section-heading"><div><p class="eyebrow">공통 ETA 카드</p><h2 id="design-guide-eta-states">상태 비교</h2></div><p class="muted">배송·관제 화면과 같은 컴포넌트</p></div>
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
        <div class="panel-heading"><div><p class="eyebrow">상세 표본</p><h2 id="design-guide-events">사건 이력</h2></div>${badge('합성 사건', 'neutral')}</div>
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

    <aside class="notice neutral design-guide-review-note" aria-label="디자인 가이드 검토 메모"><strong>검토용 합성 표본</strong><p>이 가이드는 실제 TMS 장치 연결이나 알림 발송 결과가 아닙니다. 배송 현황·단말 관제·고객 보기에서 사용할 동일 컴포넌트를 상태별로 비교합니다.</p></aside>`;

  mountTabSample(container);
  container.dataset.mounted = 'true';
}
