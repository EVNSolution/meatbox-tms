const storageKey = 'meatbox-combined-tools-position';
const phaseLabels = { unordered: '주문 전', idle: '주문 접수', preparing: '출고 준비', delivering: '배송 중', done: '배송 완료' };

export function clampPosition(x, y, width, height, viewportWidth, viewportHeight) {
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}

export function mountScenarioTools({ onSend }) {
  const panel = document.createElement('aside');
  panel.id = 'scenario-tools';
  panel.className = 'scenario-palette';
  panel.setAttribute('aria-labelledby', 'scenario-tools-heading');
  panel.innerHTML = `
    <button type="button" class="scenario-handle" aria-label="시나리오 패널 이동" title="끌어서 이동"><span aria-hidden="true">⠿</span></button>
    <div class="scenario-content">
      <div class="scenario-palette-header">
        <div><strong class="scenario-title" id="scenario-tools-heading">시나리오 제어</strong><small id="current-scenario">상태 연결 중</small></div>
        <button type="button" class="scenario-toggle" aria-expanded="false" aria-controls="scenario-body">펼치기 +</button>
      </div>
      <div class="scenario-body" id="scenario-body" hidden>
        <p class="scenario-help">상현님 시뮬레이션 원본 명령을 전송합니다.</p>
        <div class="scenario-buttons" role="group" aria-label="시뮬레이션 진행">
          <button type="button" data-command="place_order">주문 접수</button>
          <button type="button" data-command="advance">다음 단계</button>
          <button type="button" data-command="inject_traffic">교통 사고</button>
          <button type="button" data-command="inject_dwell">정차 지연</button>
        </div>
        <fieldset class="speed-controls"><legend>배속</legend><button type="button" data-speed="1">1×</button><button type="button" data-speed="5">5×</button><button type="button" data-speed="20">20×</button></fieldset>
        <div class="scenario-footer"><button type="button" class="button subtle" data-command="reset">초기화</button><a href="/scenario/present">시나리오 페이지</a></div>
        <p class="scenario-reset-help">배송 순서 변경과 건너뜀은 단말 관제의 배송 카드에서 조작합니다.</p>
      </div>
    </div>`;
  document.body.append(panel);

  const handle = panel.querySelector('.scenario-handle');
  const toggle = panel.querySelector('.scenario-toggle');
  const body = panel.querySelector('.scenario-body');
  const status = panel.querySelector('#current-scenario');

  function move(x, y) {
    const position = clampPosition(x, y, panel.offsetWidth, panel.offsetHeight, innerWidth, innerHeight);
    Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto' });
  }
  function keepInView() {
    const { x, y } = panel.getBoundingClientRect();
    move(x, y);
  }
  function save() {
    const { x, y } = panel.getBoundingClientRect();
    try { sessionStorage.setItem(storageKey, JSON.stringify({ x, y, expanded: !body.hidden })); } catch {}
  }
  function expand(expanded) {
    body.hidden = !expanded;
    panel.dataset.expanded = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '접기 −' : '펼치기 +';
    keepInView();
  }

  toggle.addEventListener('click', () => { expand(body.hidden); save(); });
  panel.addEventListener('click', event => {
    const command = event.target.closest('[data-command]')?.dataset.command;
    const speed = event.target.closest('[data-speed]')?.dataset.speed;
    if (command) onSend(command);
    if (speed) onSend('speed', { value: Number(speed) });
  });

  let drag = null;
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const { x, y } = panel.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y };
    handle.setPointerCapture(event.pointerId);
    panel.dataset.dragging = 'true';
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) move(event.clientX - drag.x, event.clientY - drag.y);
  });
  function endDrag(event) {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    delete panel.dataset.dragging;
    save();
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', keepInView);

  expand(false);
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      expand(saved.expanded === true);
      move(saved.x, saved.y);
    }
  } catch {}

  return {
    update(state, connected) {
      status.textContent = connected && state ? `${state.simClock}  ${phaseLabels[state.phase] || '상태 미확인'}  ${state.speed}×` : '연결 대기';
      panel.querySelector('[data-command="place_order"]').disabled = !connected || state?.phase !== 'unordered';
      panel.querySelector('[data-command="advance"]').disabled = !connected || !['idle', 'preparing'].includes(state?.phase);
      panel.querySelector('[data-command="inject_traffic"]').disabled = !connected || state?.phase !== 'delivering';
      panel.querySelector('[data-command="inject_dwell"]').disabled = !connected || state?.phase !== 'delivering';
      panel.querySelectorAll('[data-speed]').forEach(button => {
        button.disabled = !connected;
        button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === state?.speed));
      });
    },
  };
}
