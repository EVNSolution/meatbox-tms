import { getTerminalSnapshots } from './sample-data.mjs';
import { badge, customerCard, etaCard } from './view-components.mjs';
import { referenceIcon } from './reference-icons.mjs';

const source = (href, label) => `<a class="guide-source" href="${href}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
const heading = (number, title, description, note = '공식 사이트 관측') => `<header class="guide-section-heading"><div class="guide-section-index">${number}<span>${note}</span></div><h2>${title}</h2><p>${description}</p></header>`;
const colors = [['브랜드 레드', '#E60028', '로고와 브랜드 식별'], ['브랜드 블랙', '#212322', '워드마크와 주요 강조'], ['검색 액센트', '#DB0E64', '공식 사이트의 검색 액션']];
const neutrals = [['본문', '#232221'], ['보조 글자', '#413F3D'], ['구분선', '#E4E7EC'], ['배경', '#F2F4F7'], ['표면', '#FFFFFF']];
const iconNames = [['search', '검색'], ['location', '위치'], ['truck', '배송'], ['bell', '알림'], ['user', '내 정보'], ['support', '고객 지원'], ['close', '닫기'], ['next', '다음']];
const todayParts = Object.fromEntries(new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
const todayLabel = `${todayParts.year}.${todayParts.month}.${todayParts.day} ${todayParts.weekday}`;
const calendarIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v3m10-3v3M4.5 9h15M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>';
const dateToolbarSample = (date, readOnly = false) => `<div class="guide-date-toolbar" aria-label="${readOnly ? '과거 날짜 읽기 전용' : '날짜와 집계'} 툴바 표본">
  <div class="guide-date-actions"><span>조회 날짜</span><button type="button" class="guide-date-picker" data-guide-demo="날짜 선택기 형태 표본입니다. 실제 날짜 조회는 운영 화면에서 확인할 수 있습니다.">${calendarIcon}<span>${date}</span></button><button type="button" class="guide-date-today" ${readOnly ? 'data-guide-demo="오늘 이동 버튼 형태 표본입니다. 실제 날짜 조회는 운영 화면에서 확인할 수 있습니다."' : 'disabled'}>오늘</button></div>
  <div class="guide-date-meta">${readOnly ? '<span class="guide-date-readonly">이력 조회 · 읽기 전용</span>' : '<div class="guide-date-counts" aria-label="수량 표본"><div><span>차량</span><strong>—</strong></div><div><span>배송</span><strong>—</strong></div><div><span>완료</span><strong>—</strong></div></div>'}</div>
</div>`;

export function mountDesignGuide(container) {
  if (container.dataset.mounted === 'true') return;
  container.classList.add('design-guide');
  container.innerHTML = `
    <nav class="guide-jump-nav" aria-label="디자인 가이드 바로가기">
      ${[['navigation', '화면 구성'], ['brand', '브랜드'], ['color', '컬러'], ['type', '타이포그래피'], ['radius', 'Radius'], ['icons', '아이콘'], ['components', '컴포넌트']].map(([id, label]) => `<button type="button" data-guide-jump="${id}">${label}</button>`).join('')}
      <span>REFERENCE 01 · 2026.09.29</span>
    </nav>

    <section class="guide-section" id="guide-navigation">
      ${heading('00', '운영 업무는 좌측 메뉴에서 찾습니다', '운영 화면은 배차 관리·배송 관제·자원 관리로 나눕니다. 기기 종류인 모바일 탭은 두지 않습니다.', '현행 제품 구성')}
      <div class="guide-navigation-grid">
        <article class="guide-navigation-axis"><p class="eyebrow">좌측 · 운영 업무 메뉴</p><div class="guide-navigation-items"><span>배차 관리</span><span>배송 관제</span><span>자원 관리</span></div><p>날짜별 배차와 관제, 차량 등록부를 서로 다른 업무 화면으로 구분합니다.</p></article>
        <article class="guide-navigation-axis"><p class="eyebrow">내부 검토 · 고객과 배송원</p><div class="guide-navigation-items"><span>고객 화면 검토</span><span>배송원 흐름 검토</span></div><p>기존 직행 링크로 화면을 확인합니다. 고객별·배송원별 서버 권한이 없어 실제 사용자용 화면이나 운영 모바일 탭으로 제공하지 않습니다.</p></article>
      </div>
      <div class="guide-management-location"><strong>배차 관리 <span>→</span> 배송 관제 <span>→</span> 자원 관리</strong><p>디자인 가이드는 별도 검토용 경로입니다. 위 업무 이름과 날짜 툴바는 현행 제품의 구조를 따릅니다.</p><small>이 페이지의 배송 수량과 상태 예시는 실제 운영 자료가 아닙니다.</small></div>
    </section>

    <section class="guide-section" id="guide-brand">
      ${heading('01', '미트박스의 얼굴부터 정확하게', '공식 로고의 형태와 색을 그대로 사용하고, 앱 아이콘과 기능 아이콘의 역할을 구분합니다.')}
      <div class="guide-brand-grid">
        <article class="guide-specimen guide-logo-specimen">
          <div class="guide-specimen-top"><h3>한국어 로고</h3><span>공식 SVG 원본</span></div>
          <div class="guide-logo-stage"><img src="./assets/meatbox-logo.svg" width="315" height="75" alt="빨간 상자 심벌과 미트박스 워드마크"></div>
          <div class="guide-lockup-row"><div class="guide-lockup"><img src="./assets/meatbox-logo.svg" width="126" height="30" alt="미트박스"><span>TMS</span></div><p>제품명 조합 <span>로컬 제안</span></p></div>
          <p class="guide-note">심벌의 소 실루엣, 상자 형태, 워드마크의 비율을 유지합니다.</p>
          ${source('https://static-cdn.meatbox.co.kr/public/fstatic/icon/common/M_Logo.svg', '공식 로고 원본')}
        </article>
        <article class="guide-specimen guide-app-specimen">
          <div class="guide-specimen-top"><h3>앱 아이콘</h3><span>공식 App Store 자산</span></div>
          <div class="guide-app-stage"><img src="./assets/meatbox-app.webp" width="112" height="112" alt="미트박스 공식 앱 아이콘"><div><strong>미트박스</strong><p>흰 바탕, 붉은 상자<br>작은 크기에서도 이어지는 브랜드</p></div></div>
          <div class="guide-app-sizes">${[40, 24, 16].map(size => `<figure><img src="./assets/meatbox-app.webp" width="${size}" height="${size}" alt="${size}픽셀 앱 아이콘"><figcaption>${size}px</figcaption></figure>`).join('')}</div>
          ${source('https://apps.apple.com/kr/app/id992338216', '공식 앱 보기')}
        </article>
      </div>
    </section>

    <section class="guide-section" id="guide-color">
      ${heading('02', '브랜드 색과 액션 색의 쓰임', '로고의 붉은색과 검색의 자홍색은 서로 다른 값입니다. 배경과 본문은 차분하게 유지합니다.')}
      <div class="guide-colors">${colors.map(([label, hex, usage]) => `<button class="guide-color" type="button" data-copy-color="${hex}" aria-label="${label} ${hex} 복사"><span class="guide-color-surface" style="background:${hex}"><span>${hex}</span></span><span class="guide-color-info"><strong>${label}</strong><span>${usage}</span><small>색상 복사 ↗</small></span></button>`).join('')}</div>
      <div class="guide-neutrals">${neutrals.map(([label, hex]) => `<div><span class="guide-neutral-chip" style="background:${hex}"></span><span>${label}<small>${hex}</small></span></div>`).join('')}</div>
      <div class="guide-semantic-row"><div><h3>상태는 의미로 구분합니다</h3><p>상태 색은 배송 UI를 위한 로컬 제안입니다.</p></div><div class="guide-inline">${badge('배송 중', 'blue')}${badge('배송 완료', 'green')}${badge('ETA 변경', 'amber')}${badge('미확정', 'neutral')}</div></div>
    </section>

    <section class="guide-section" id="guide-type">
      ${heading('03', '굵기는 정보의 중요도를 따라', 'Pretendard의 네 가지 굵기를 비교합니다. 제목과 시간만 강하게, 설명은 편안하게 읽히도록 합니다.', '공식 글꼴 관측 · 위계는 로컬 제안')}
      <label class="guide-type-editor"><span>비교할 문구</span><input id="guide-type-input" value="배송 상태를 한눈에" maxlength="60" autocomplete="off"></label>
      <div class="guide-weights">${[[400, 'Regular', '본문과 설명'], [500, 'Medium', '메뉴와 상태'], [600, 'SemiBold', '버튼과 섹션'], [700, 'Bold', '제목과 주요 시간']].map(([weight, label, usage]) => `<article><div class="guide-weight-label"><strong>${weight}</strong><span>${label}</span></div><p data-type-text style="font-weight:${weight}">배송 상태를 한눈에</p><small>${usage}</small></article>`).join('')}</div>
      <div class="guide-type-scale">
        <div><span>페이지 제목</span><p style="font-size:28px;font-weight:700">배송 목록</p><small>28 / 700</small></div>
        <div><span>섹션 제목</span><p style="font-size:20px;font-weight:600">도착 예정 시간</p><small>20 / 600</small></div>
        <div><span>본문</span><p style="font-size:14px;font-weight:400">배송 상태가 변경되면 최신 정보로 안내합니다.</p><small>14 / 400</small></div>
        <div><span>보조 정보</span><p style="font-size:12px;font-weight:400">마지막 갱신 14:32 · 합성 표본</p><small>12 / 400</small></div>
        <div><span>주요 시간</span><p class="guide-time-sample">14:40–15:00</p><small>32 / 700</small></div>
      </div>
    </section>

    <section class="guide-section" id="guide-radius">
      ${heading('04', '모서리도 요소의 역할에 맞게', '공식 화면에서는 작은 버튼부터 배너까지 서로 다른 반경을 사용합니다. 용도별로 직접 비교해 보세요.')}
      <div class="guide-radius-samples">${[[4, '앱 열기'], [6, '보조 버튼'], [8, '상품 분류'], [12, '앱 안내 배너']].map(([radius, label]) => `<figure><div style="border-radius:${radius}px"><strong>${radius}<span>px</span></strong></div><figcaption>${label}</figcaption></figure>`).join('')}</div>
      <div class="guide-radius-lab"><div><h3>컨트롤에 적용해 보기</h3><p>현재 <output id="guide-radius-value">6px</output> · 로컬 비교 표본</p><div class="guide-segmented" role="group" aria-label="컨트롤 모서리 반경">${[4, 6, 8, 12].map(radius => `<button type="button" data-radius="${radius}" aria-pressed="${radius === 6}">${radius}px</button>`).join('')}</div></div><div class="guide-radius-controls"><label><span>배송 번호</span><input value="MB-2026-0914" aria-label="배송 번호 표본"></label><button type="button" class="guide-button is-primary" data-guide-demo="선택한 모서리 반경의 버튼 표본입니다.">배송 조회</button></div></div>
      <div class="guide-shape-note"><div><span class="guide-pill">검색 입력 · pill</span><button type="button" class="guide-round-search" aria-label="원형 검색 버튼 표본" data-guide-demo="공식 검색 액션의 원형과 색상 표본입니다.">${referenceIcon('search')}</button></div><p>검색의 캡슐형과 원형은 목적이 있는 예외로 사용합니다.</p></div>
    </section>

    <section class="guide-section" id="guide-icons">
      ${heading('05', '아이콘은 동작을 읽는 단서', '공식 사이트의 기능 아이콘 형태를 가져왔습니다. 브랜드 심벌은 식별에, 기능 아이콘은 행동에 사용합니다.')}
      <div class="guide-toolbar"><p>공식 SVG 형태 · 단색 아이콘</p><label>표시 크기<select id="guide-icon-size"><option value="16">16px</option><option value="20" selected>20px</option><option value="24">24px</option></select></label></div>
      <div class="guide-icon-grid">${iconNames.map(([name, label]) => `<figure><div>${referenceIcon(name)}</div><figcaption>${label}</figcaption></figure>`).join('')}</div>
      <div class="guide-icon-examples">
        <article><h3>아이콘 + 텍스트</h3><p>업무 액션은 이름까지 함께</p><div class="guide-inline"><button type="button" class="guide-button" data-guide-demo="배송 조회 버튼의 아이콘·문구 표본입니다.">${referenceIcon('truck')}배송 조회</button><button type="button" class="guide-button" data-guide-demo="고객 안내 버튼 표본입니다. 실제 안내는 발송되지 않습니다.">${referenceIcon('support')}고객 안내</button></div></article>
        <article><h3>선택 상태</h3><p>색과 문구로 함께 구분</p><button type="button" class="guide-button guide-toggle" id="guide-notification-toggle" aria-pressed="true">${referenceIcon('bell')}<span>알림 표시 켜짐</span></button></article>
        <article><h3>아이콘 단독</h3><p>명확한 이름과 44px 조작 영역</p><div class="guide-inline"><button type="button" class="guide-icon-button" aria-label="검색 아이콘 표본" data-guide-demo="검색 · 44px 조작 영역">${referenceIcon('search')}</button><button type="button" class="guide-icon-button" aria-label="닫기 아이콘 표본" data-guide-demo="닫기 · 44px 조작 영역">${referenceIcon('close')}</button></div></article>
      </div>
    </section>

    <section class="guide-section" id="guide-components">
      ${heading('06', '업무 화면의 공통 요소', '날짜·집계 툴바와 배송·고객 안내를 상태별로 비교합니다.', '현행 툴바 표본 · 로컬 제안')}
      <div class="guide-date-pattern">
        <div class="guide-date-pattern-heading"><h3>운영 날짜·집계 툴바</h3><p>날짜 조작은 왼쪽, 읽기 전용 상태와 집계는 오른쪽에 둡니다. 높이가 다른 요소를 한 묶음에 중앙 정렬하지 않습니다.</p></div>
        <div class="guide-date-pattern-grid">
          <article><div class="guide-preview-label"><span>날짜와 집계</span><span>수량 기호는 UI 표본</span></div><div class="guide-date-stage">${dateToolbarSample(todayLabel)}</div></article>
          <article><div class="guide-preview-label"><span>과거 날짜 · 자료 없음</span><span>집계를 숨기고 상태만 표시</span></div><div class="guide-date-stage">${dateToolbarSample('2026.09.25 금', true)}</div></article>
        </div>
        <p class="guide-note">날짜 선택기와 인접 버튼은 44px 높이로 맞춥니다. 좁은 화면에서는 조작 뒤에 상태·집계가 줄바꿈합니다. 이 표본은 실제 조회나 운영 수량과 연결되지 않습니다.</p>
      </div>
      <div class="guide-toolbar guide-state-toolbar"><div class="guide-inline">${badge('합성 표본', 'neutral')}<span>실제 배송·알림 발송과 연결되지 않습니다.</span></div><label>배송 상태<select id="guide-scenario"><option value="departure">정상 배송</option><option value="traffic" selected>ETA 변경</option><option value="preparing">ETA 미확정</option><option value="stale">갱신 지연</option><option value="completed">배송 완료</option></select></label></div>
      <div class="guide-component-grid"><article><div class="guide-preview-label"><span>운영 뷰어 · 배송 관제</span><span>정보와 변경 이유를 함께</span></div><section class="panel" id="guide-operations-preview" aria-labelledby="guide-eta-heading"></section></article><article><div class="guide-preview-label"><span>고객 뷰어</span><span>현재 상태와 다음 안내</span></div><div class="guide-customer-shell"><div class="guide-customer-brand"><img src="./assets/meatbox-logo.svg" width="105" height="25" alt="미트박스"><span>배송조회</span></div><div id="guide-customer-preview"></div></div></article></div>
      <div class="guide-button-hierarchy"><div><h3>명확한 액션 위계</h3><p>한 영역에서 주요 행동 하나를 강조합니다.</p></div><div class="guide-inline"><button type="button" class="guide-button is-primary" data-guide-demo="주요 액션 버튼 표본입니다.">주요 액션</button><button type="button" class="guide-button" data-guide-demo="보조 액션 버튼 표본입니다.">보조 액션</button><button type="button" class="guide-button is-quiet" data-guide-demo="낮은 강조 버튼 표본입니다.">낮은 강조</button><button type="button" class="guide-button" disabled>비활성</button></div></div>
    </section>

    <footer class="guide-footer"><div><strong>공식 근거에서 시작하는 UI</strong><p>로고·앱 아이콘·기능 아이콘은 공식 자산, 색상·굵기·Radius는 화면 관측값입니다.<br>배치·간격·상태 색·제품명 조합은 이번 로컬 레퍼런스의 제안입니다.</p></div><div class="guide-source-links">${source('https://www.meatbox.co.kr/', '미트박스')}${source('https://meatbox.career.greetinghr.com/ko/aboutus', '회사 소개')}${source('https://www.w3.org/TR/WCAG22/', '접근성 기준')}</div></footer>
    <div class="guide-toast" role="status" aria-live="polite"></div>`;

  let toastTimer;
  const announce = message => {
    const toast = container.querySelector('.guide-toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  };
  container.querySelectorAll('[data-guide-jump]').forEach(button => button.addEventListener('click', () => {
    container.querySelector(`#guide-${button.dataset.guideJump}`).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }));
  container.querySelectorAll('[data-copy-color]').forEach(button => button.addEventListener('click', async () => {
    const color = button.dataset.copyColor;
    try { await navigator.clipboard.writeText(color); announce(`${color} 복사했습니다.`); }
    catch { announce(`색상 값: ${color}`); }
  }));
  container.querySelector('#guide-type-input').addEventListener('input', event => {
    container.querySelectorAll('[data-type-text]').forEach(sample => { sample.textContent = event.target.value || '배송 상태를 한눈에'; });
  });
  container.querySelectorAll('[data-radius]').forEach(button => button.addEventListener('click', () => {
    container.querySelectorAll('[data-radius]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    container.querySelector('.guide-radius-controls').style.setProperty('--guide-control-radius', `${button.dataset.radius}px`);
    container.querySelector('#guide-radius-value').textContent = `${button.dataset.radius}px`;
  }));
  container.querySelector('#guide-icon-size').addEventListener('change', event => {
    container.querySelector('.guide-icon-grid').style.setProperty('--reference-icon-size', `${event.target.value}px`);
  });
  container.querySelector('#guide-notification-toggle').addEventListener('click', event => {
    const button = event.currentTarget;
    const enabled = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(enabled));
    button.querySelector('span').textContent = `알림 표시 ${enabled ? '켜짐' : '꺼짐'}`;
  });
  container.querySelectorAll('[data-guide-demo]').forEach(button => button.addEventListener('click', () => announce(button.dataset.guideDemo)));
  const renderScenario = scenario => {
    const terminal = getTerminalSnapshots(scenario)[0];
    container.querySelector('#guide-operations-preview').innerHTML = etaCard(terminal, 'guide-eta-heading');
    container.querySelector('#guide-customer-preview').innerHTML = customerCard(terminal);
  };
  renderScenario('traffic');
  container.querySelector('#guide-scenario').addEventListener('change', event => {
    renderScenario(event.target.value);
    announce(`${event.target.selectedOptions[0].textContent} 표본으로 바뀌었습니다.`);
  });
  container.dataset.mounted = 'true';
}
