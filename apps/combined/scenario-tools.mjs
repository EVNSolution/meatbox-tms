import { scenarioGuide } from './scenario-guide.mjs';
import { deliveryContext, deliveryChanges } from './delivery-review.mjs';

const storageKey = 'meatbox-combined-tools-position';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

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
        <div><strong class="scenario-title" id="scenario-tools-heading">시연 가이드</strong><small id="current-scenario">상태 연결 중</small></div>
        <button type="button" class="scenario-toggle" aria-expanded="false" aria-controls="scenario-body">펼치기 +</button>
      </div>
      <div class="scenario-body" id="scenario-body" hidden>
        <div class="scenario-clock-row"><div><span>시연 시각</span><time id="scenario-clock">--:--</time></div><span id="scenario-count"></span></div>
        <section class="scenario-current" aria-labelledby="scenario-stage"><span class="scenario-label">현재 단계</span><h2 id="scenario-stage">연결 중</h2><p id="scenario-description"></p></section>
        <section class="scenario-next" aria-labelledby="scenario-next-title"><div class="scenario-next-heading"><span class="scenario-label">다음</span><strong id="scenario-next-title"></strong><time id="scenario-next-time"></time></div><p id="scenario-effect"></p><small id="scenario-elapsed"></small><button type="button" class="scenario-primary" id="scenario-next-action" disabled>상태 연결 중</button></section>
        <p class="scenario-completed" id="scenario-completed" hidden></p>
        <details class="scenario-guide-details"><summary>단계별 시연 순서</summary><ol id="scenario-steps"></ol><p>출발 후에는 각 배송지의 <strong>이동 → 도착·하차 → 배송 완료</strong>를 반복합니다. 이동은 자동으로 진행되고, 하차 시간이 끝나면 자동 완료됩니다. 다음 행동 버튼으로 기다리는 시간을 줄일 수 있습니다.</p></details>
        <details class="scenario-guide-details"><summary>최근 변동과 시각</summary><ol class="scenario-events" id="scenario-events"></ol></details>
        <p class="scenario-error" id="scenario-error" role="alert" hidden></p>
        <span class="scenario-label">추가 상황</span>
        <div class="scenario-buttons" role="group" aria-label="시뮬레이션 진행">
          <button type="button" data-command="inject_traffic">교통 사고</button>
          <button type="button" data-command="inject_dwell">정차 지연</button>
        </div>
        <fieldset class="speed-controls"><legend>배속</legend><button type="button" data-speed="1">1×</button><button type="button" data-speed="5">5×</button><button type="button" data-speed="20">20×</button></fieldset>
        <div class="scenario-footer"><button type="button" class="button subtle" data-command="reset">초기화</button><a href="/scenario/present">원본 발표 리모컨</a></div>
        <p class="scenario-reset-help">단계를 진행하거나 초기화하면 모든 접속자에게 반영됩니다. 순서 변경과 보류는 배송 관리에서 할 수 있습니다.</p>
      </div>
    </div>`;
  const advanced = document.createElement('details');
  advanced.className = 'scenario-advanced';
  advanced.innerHTML = '<summary>배속·초기화 및 상세 설정</summary>';
  let node = panel.querySelector('#scenario-completed');
  while (node) { const next = node.nextElementSibling; advanced.append(node); node = next; }
  panel.querySelector('.scenario-current').insertAdjacentHTML('beforeend', '<p class="scenario-context" id="scenario-vehicle"></p><p class="scenario-context" id="scenario-customer"></p>');
  advanced.firstElementChild.insertAdjacentHTML('afterend', '<p id="scenario-context-note"></p><details class="scenario-guide-details"><summary id="scenario-change-summary">단계를 진행하면 전후 변화를 확인할 수 있습니다.</summary><p id="scenario-change-note"></p><ul class="scenario-change-rows" id="scenario-change-rows"></ul></details>');
  panel.querySelector('.scenario-body').append(advanced);
  document.body.append(panel);

  const handle = panel.querySelector('.scenario-handle');
  const toggle = panel.querySelector('.scenario-toggle');
  const body = panel.querySelector('.scenario-body');
  const status = panel.querySelector('#current-scenario');
  const primary = panel.querySelector('#scenario-next-action');
  let nextAction = null;
  let pending = false;
  let connected = false;
  let selectedId;
  let latest;
  let lastChanges;
  const put = (id, text) => { panel.querySelector(`#${id}`).textContent = text || ''; };

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
    toggle.textContent = expanded ? '접기 −' : '시연 가이드 +';
    keepInView();
  }

  toggle.addEventListener('click', () => { expand(body.hidden); save(); });
  primary.addEventListener('click', () => {
    if (pending || !nextAction?.action) return;
    pending = true;
    primary.disabled = true;
    panel.querySelector('#scenario-error').hidden = true;
    onSend(nextAction.action, nextAction.stopId ? { stopId: nextAction.stopId } : {});
  });
  panel.addEventListener('click', event => {
    const command = event.target.closest('[data-command]')?.dataset.command;
    const speed = event.target.closest('[data-speed]')?.dataset.speed;
    if (command) onSend(command);
    if (speed) onSend('speed', { value: Number(speed) });
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !body.hidden) { expand(false); save(); toggle.focus(); }
  });
  handle.addEventListener('keydown', event => {
    const moves = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
    if (!moves[event.key]) return;
    event.preventDefault();
    const { x, y } = panel.getBoundingClientRect();
    move(x + moves[event.key][0], y + moves[event.key][1]);
    save();
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
  new ResizeObserver(keepInView).observe(panel);

  expand(false);
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      expand(saved.expanded === true);
      move(saved.x, saved.y);
    }
  } catch {}

  function renderContext() {
    if (!latest) return;
    const selected = latest.deliveries.find(stop => stop.id === (selectedId === undefined ? latest.customerStopId : selectedId));
    const context = deliveryContext(latest, selected);
    put('scenario-vehicle', `차량 · ${context.vehicle}`);
    put('scenario-customer', `선택 배송 · ${context.customer}`);
    put('scenario-context-note', context.note);
    const own = lastChanges?.deliveries[selected?.id]?.rows || [];
    let rows = lastChanges ? [...lastChanges.global, ...own] : [];
    if (lastChanges && !rows.length) {
      const other = Object.values(lastChanges.deliveries)[0];
      if (other) rows = other.rows.map(row => ({ ...row, label: `${other.name} · ${row.label}` }));
    }
    const first = rows[0];
    put('scenario-change-summary', first ? `최근 변동 ${lastChanges.time} · ${first.label}: ${first.before} → ${first.after}` : '단계를 진행하면 전후 변화를 확인할 수 있습니다.');
    put('scenario-change-note', lastChanges && selected && !own.length ? `${selected.name} 고객 안내는 그대로입니다.` : lastChanges ? '선택 배송과 전체 진행에서 바뀐 내용입니다.' : '이 페이지를 연 뒤 바뀐 내용만 표시합니다.');
    panel.querySelector('#scenario-change-rows').innerHTML = rows.map(row => `<li><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.before)} → ${escapeHtml(row.after)}</span></li>`).join('');
  }

  return {
    select(id) { selectedId = id; renderContext(); },
    showError(message) {
      expand(true);
      advanced.open = true;
      put('scenario-error', message);
      panel.querySelector('#scenario-error').hidden = false;
      pending = false;
      primary.disabled = !connected || !nextAction?.action;
    },
    update(state, isConnected) {
      connected = isConnected;
      if (state) {
        if (state.phase === 'unordered' && latest?.phase !== 'unordered') lastChanges = null;
        const changes = deliveryChanges(latest, state);
        if (changes) lastChanges = changes;
        latest = state;
        renderContext();
      }
      const guide = scenarioGuide(state);
      nextAction = guide;
      pending = false;
      status.textContent = connected && guide ? `${state.simClock} · ${guide.title}` : '연결 대기';
      primary.disabled = !connected || !guide?.action;
      put('scenario-next-action', connected ? guide?.actionLabel || '배송 시연 완료' : '연결 대기');
      if (guide) {
        put('scenario-clock', state.simClock);
        put('scenario-count', `완료 ${guide.doneCount} / ${guide.totalCount}곳`);
        put('scenario-stage', guide.title);
        put('scenario-description', guide.description);
        put('scenario-next-title', guide.nextTitle);
        put('scenario-next-time', guide.nextTime ? `${guide.nextTime}${guide.estimated ? ' 예상' : ''}` : '');
        put('scenario-effect', guide.effect);
        put('scenario-elapsed', guide.elapsed);
        const completed = guide.latestCompleted;
        panel.querySelector('#scenario-completed').hidden = !completed;
        put('scenario-completed', completed ? `최근 완료 ${completed.sequence}번 ${completed.name} · 도착 ${completed.arrivedAt || '미확인'} / 완료 ${completed.completedAt || '미확인'}` : '');
        panel.querySelector('#scenario-steps').innerHTML = guide.steps.map(step => `<li data-state="${step.state}"><div><strong>${escapeHtml(step.label)}</strong><time>${escapeHtml(step.actualTime || step.time)}${step.actualTime ? '' : ' 예정'}</time></div><p>${escapeHtml(step.description)}</p></li>`).join('');
        panel.querySelector('#scenario-events').innerHTML = guide.recentEvents.map(event => `<li><time>${escapeHtml(event.time)}</time><span>${escapeHtml(event.message)}</span></li>`).join('') || '<li>아직 변동이 없습니다.</li>';
      }
      panel.querySelector('[data-command="inject_traffic"]').disabled = !connected || state?.phase !== 'delivering' || state.incidents.length > 0;
      panel.querySelector('[data-command="inject_dwell"]').disabled = !connected || state?.phase !== 'delivering';
      panel.querySelector('[data-command="reset"]').disabled = !connected;
      panel.querySelectorAll('[data-speed]').forEach(button => {
        button.disabled = !connected;
        button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === state?.speed));
      });
    },
  };
}
