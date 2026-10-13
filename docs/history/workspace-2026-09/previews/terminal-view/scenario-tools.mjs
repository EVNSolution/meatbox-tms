const storageKey = 'meatbox-scenario-tools-position';

export function clampPosition(x, y, width, height, viewportWidth, viewportHeight) {
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}

// The page supplies the scenario actions; the floating layer owns only its UI.
export function mountScenarioTools({ options, selected, onSelect, onReset }) {
  const panel = document.createElement('aside');
  panel.id = 'scenario-tools';
  panel.className = 'scenario-palette';
  panel.setAttribute('aria-labelledby', 'scenario-tools-heading');
  panel.innerHTML = `
    <button type="button" class="scenario-handle" aria-label="시나리오 패널 이동" title="끌어서 이동 · 방향키로 이동 · Home으로 위치 복원"><span aria-hidden="true">⠿</span></button>
    <div class="scenario-content">
      <div class="scenario-palette-header"><div><strong class="scenario-title" id="scenario-tools-heading">시나리오</strong><small id="current-scenario"></small></div><button type="button" class="scenario-toggle" id="toggle-scenarios" aria-expanded="false" aria-controls="scenario-body">펼치기 +</button></div>
      <div class="scenario-body" id="scenario-body" hidden>
        <p class="scenario-help">TMS-001 표본을 선택하고 조회 조건을 초기화합니다.</p>
        <div class="scenario-buttons" id="scenario-buttons" role="group" aria-label="TMS-001 시연 표본 선택"></div>
        <div class="scenario-footer"><button type="button" class="button subtle" id="reset-demo" aria-describedby="scenario-reset-help">출발 상태로 초기화</button><small>가상 데이터</small></div>
        <p class="scenario-reset-help" id="scenario-reset-help">조회 조건·선택 배송·상세 보기도 함께 초기화됩니다.</p>
      </div>
    </div>`;
  const handle = panel.querySelector('.scenario-handle');
  const toggle = panel.querySelector('#toggle-scenarios');
  const body = panel.querySelector('#scenario-body');
  const buttons = panel.querySelector('#scenario-buttons');
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.dataset.scenario = option.id;
    const code = document.createElement('span');
    code.className = 'scenario-code';
    code.textContent = option.code;
    button.append(code, option.label);
    button.addEventListener('click', () => onSelect(option.id));
    buttons.append(button);
  }
  document.body.append(panel);

  function update(scenario) {
    panel.querySelector('#current-scenario').textContent = `${options.find(option => option.id === scenario).label} 표본`;
    buttons.querySelectorAll('[data-scenario]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario)));
  }
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
    try { sessionStorage.setItem(storageKey, JSON.stringify({ x, y, expanded: !body.hidden })); } catch { /* Position is optional when storage is unavailable. */ }
  }
  function expand(expanded) {
    body.hidden = !expanded;
    panel.dataset.expanded = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '접기 −' : '펼치기 +';
    keepInView();
  }
  update(selected);
  expand(false);
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      expand(saved.expanded === true);
      move(saved.x, saved.y);
    }
  } catch { /* Use the default placement when saved UI state cannot be read. */ }

  toggle.addEventListener('click', () => { expand(body.hidden); save(); });
  panel.querySelector('#reset-demo').addEventListener('click', onReset);
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || body.hidden) return;
    expand(false);
    toggle.focus();
    save();
    event.stopPropagation();
  });

  let drag = null;
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const { x, y } = panel.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y };
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
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
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 40 : 10;
    const offsets = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const offset = offsets[event.key];
    if (!offset && event.key !== 'Home') return;
    event.preventDefault();
    const { x, y } = panel.getBoundingClientRect();
    if (offset) move(x + offset[0], y + offset[1]);
    else move(innerWidth - panel.offsetWidth - 20, innerHeight - panel.offsetHeight - 20);
    save();
  });
  window.addEventListener('resize', keepInView);
  return { update };
}
