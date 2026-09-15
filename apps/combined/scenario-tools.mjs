import { scenarioGroups, scenarioGuide } from './scenario-guide.mjs';

const storageKey = 'meatbox-combined-tools-expanded';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function selectedScenarioTarget(state, selectedId) {
  if (!state) return null;
  const deliveries = state.fleetDeliveries || state.deliveries || [];
  const id = selectedId == null ? state.customerStopId : selectedId;
  return deliveries.find(delivery => delivery.id === id) || null;
}

export function canSetScenario(delivery) {
  if (!delivery || delivery.vehicle?.live === false) return false;
  return delivery.vehicle?.live === true || delivery.vehicleId === 'V1' || /^S[1-8]$/.test(delivery.id);
}

export function scenarioSelectionState(state, target, connected) {
  const controllable = canSetScenario(target);
  const current = scenarioGuide(state);
  const hasPresetMetadata = Boolean(state && Object.hasOwn(state, 'scenarioPreset'));
  const activeScenario = current && (!hasPresetMetadata || state.scenarioStopId === target?.id) ? current.scenario : null;
  const status = !connected ? '연결 대기'
    : target && !controllable ? '조회 전용'
      : activeScenario ? current.title : '상태 선택';
  return { activeScenario, controllable, status };
}

export function mountScenarioTools({ onSend }) {
  const panel = document.createElement('aside');
  panel.id = 'scenario-tools';
  panel.className = 'scenario-palette';
  panel.setAttribute('aria-labelledby', 'scenario-tools-heading');
  panel.innerHTML = `
    <div class="scenario-palette-header">
      <div><strong class="scenario-title" id="scenario-tools-heading">시나리오</strong><small id="current-scenario">연결 대기</small></div>
      <button type="button" class="scenario-toggle" aria-expanded="false" aria-controls="scenario-body">시나리오</button>
    </div>
    <div class="scenario-body" id="scenario-body" hidden>
      <p class="scenario-target" id="scenario-target"></p>
      <div class="scenario-groups">
        ${scenarioGroups.map(group => `<fieldset class="scenario-group"><legend>${group.label}</legend><div class="scenario-buttons">${group.scenarios.map(scenario => `<button type="button" data-scenario="${scenario.id}" aria-pressed="false">${scenario.label}</button>`).join('')}</div></fieldset>`).join('')}
      </div>
      <p class="scenario-note" id="scenario-note"></p>
      <p class="scenario-error" id="scenario-error" role="alert" hidden></p>
    </div>`;
  document.body.append(panel);

  const toggle = panel.querySelector('.scenario-toggle');
  const body = panel.querySelector('.scenario-body');
  const status = panel.querySelector('#current-scenario');
  const note = panel.querySelector('#scenario-note');
  const error = panel.querySelector('#scenario-error');
  const buttons = [...panel.querySelectorAll('[data-scenario]')];
  let selectedId;
  let latest;
  let connected = false;
  let pending = false;

  function save(expanded) {
    try { sessionStorage.setItem(storageKey, String(expanded)); } catch {}
  }

  function expand(expanded) {
    body.hidden = !expanded;
    panel.dataset.expanded = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '닫기' : '시나리오';
  }

  function render() {
    const target = selectedScenarioTarget(latest, selectedId);
    const selection = scenarioSelectionState(latest, target, connected);
    const { activeScenario, controllable, status: statusText } = selection;
    status.textContent = statusText;
    const unavailable = !connected || !controllable;
    panel.querySelector('#scenario-target').innerHTML = target
      ? `선택 배송 <strong>${escapeHtml(target.name || target.id)}</strong>`
      : '배송지를 선택해 주세요.';
    if (!connected) note.textContent = '연결이 복구되면 상태를 선택할 수 있습니다.';
    else if (target && !controllable) note.textContent = '조회 전용 배송은 상태를 변경할 수 없습니다.';
    else if (!target) note.textContent = '실시간 차량의 배송지를 선택하면 상태를 변경할 수 있습니다.';
    else note.textContent = '원하는 상태를 순서와 관계없이 선택할 수 있습니다.';
    buttons.forEach(button => {
      button.disabled = unavailable || pending;
      button.setAttribute('aria-pressed', String(button.dataset.scenario === activeScenario));
    });
  }

  toggle.addEventListener('click', () => {
    expand(body.hidden);
    save(!body.hidden);
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !body.hidden) {
      expand(false);
      save(false);
      toggle.focus();
    }
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-scenario]');
    if (!button || button.disabled) return;
    const target = selectedScenarioTarget(latest, selectedId);
    if (!canSetScenario(target)) return;
    if (latest?.scenarioPreset === button.dataset.scenario && latest?.scenarioStopId === target.id) return;
    pending = true;
    error.hidden = true;
    render();
    onSend('set_scenario', { scenario: button.dataset.scenario, stopId: target.id });
  });

  let expanded = false;
  try { expanded = sessionStorage.getItem(storageKey) === 'true'; } catch {}
  expand(expanded);

  return {
    select(id) {
      selectedId = id;
      render();
    },
    showError(message) {
      pending = false;
      error.textContent = message;
      error.hidden = false;
      expand(true);
      save(true);
      render();
    },
    update(state, isConnected) {
      latest = state || latest;
      connected = isConnected;
      pending = false;
      error.hidden = true;
      render();
    },
  };
}
