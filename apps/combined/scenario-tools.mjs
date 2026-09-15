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
  const controllable = !state?.dispatch?.readOnly && (state?.customerDemo ? Boolean(target)
    : (!state?.dispatch || state.dispatch.phase === 'published') && canSetScenario(target));
  const current = scenarioGuide(state);
  const hasPresetMetadata = Boolean(state && Object.hasOwn(state, 'scenarioPreset'));
  const activeScenario = current && (!hasPresetMetadata || state.scenarioStopId === target?.id) ? current.scenario : null;
  const status = !connected ? '연결 대기'
    : target && !controllable ? '조회 전용'
      : activeScenario ? current.title : '상태 선택';
  return { activeScenario, controllable, status };
}

export function nextScenarioTarget(state, selectedId) {
  const target = selectedScenarioTarget(state, selectedId);
  if (state?.customerDemo && !state.dispatch?.readOnly) {
    const route = state.deliveries || [];
    const index = route.findIndex(delivery => delivery.id === target?.id);
    return index >= 0 ? route[index + 1] || null : null;
  }
  if (state?.dispatch?.readOnly || (state?.dispatch && state.dispatch.phase !== 'published') || !canSetScenario(target)) return null;
  const route = state?.deliveries || [];
  const index = route.findIndex(delivery => delivery.id === target.id);
  const next = index >= 0 ? route[index + 1] : null;
  return canSetScenario(next) && next.vehicleId === target.vehicleId ? next : null;
}

export function mountScenarioTools({ onSend, onSelect }) {
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
      <button type="button" class="scenario-next" id="scenario-next" disabled>다음 배송지<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></button>
      <div class="scenario-groups">
        ${scenarioGroups.map(group => `<fieldset class="scenario-group"><legend>${group.label}</legend><div class="scenario-buttons">${group.scenarios.map(scenario => `<button type="button" data-scenario="${scenario.id}" aria-pressed="false">${scenario.label}</button>`).join('')}</div></fieldset>`).join('')}
      </div>
      <div class="scenario-demo-actions" hidden>
        <button type="button" class="scenario-next" id="customer-random-position">차량 위치 바꾸기</button>
        <button type="button" class="scenario-next" id="customer-reset-scenario">시연 초기화</button>
      </div>
      <p class="scenario-note" id="scenario-note"></p>
      <p class="scenario-error" id="scenario-error" role="alert" hidden></p>
    </div>`;
  document.body.append(panel);

  const toggle = panel.querySelector('.scenario-toggle');
  const body = panel.querySelector('.scenario-body');
  const status = panel.querySelector('#current-scenario');
  const note = panel.querySelector('#scenario-note');
  const nextButton = panel.querySelector('#scenario-next');
  const error = panel.querySelector('#scenario-error');
  const buttons = [...panel.querySelectorAll('[data-scenario]')];
  const randomButton = panel.querySelector('#customer-random-position');
  const resetButton = panel.querySelector('#customer-reset-scenario');
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
    const customerDemo = Boolean(latest?.customerDemo);
    panel.querySelector('#scenario-tools-heading').textContent = customerDemo ? '고객 시연' : '시나리오';
    panel.querySelector('.scenario-demo-actions').hidden = !customerDemo;
    randomButton.disabled = unavailable || pending || !target?.customerDemo?.truck || Boolean(target?.arrivedAt);
    resetButton.disabled = unavailable || pending;
    const next = nextScenarioTarget(latest, selectedId);
    nextButton.disabled = unavailable || pending || !next;
    const last = controllable && !next && latest?.deliveries?.at(-1)?.id === target.id;
    nextButton.firstChild.textContent = last ? '마지막 배송지' : '다음 배송지';
    nextButton.title = next ? next.name || next.id : '';
    panel.querySelector('#scenario-target').innerHTML = target
      ? `선택 배송 <strong>${escapeHtml(target.name || target.id)}</strong>`
      : '배송지를 선택해 주세요.';
    if (!connected) note.textContent = '연결이 복구되면 상태를 선택할 수 있습니다.';
    else if (target && !controllable) note.textContent = '조회 전용 배송은 상태를 변경할 수 없습니다.';
    else if (!target) note.textContent = '실시간 차량의 배송지를 선택하면 상태를 변경할 수 있습니다.';
    else note.textContent = customerDemo ? '선택한 매장에서만 시연합니다. 실제 배차·배송 완료 기록에는 반영되지 않습니다.'
      : latest?.sourceData ? '완료는 배송원 뷰어에서 사진을 확인한 뒤 처리합니다.' : '원하는 상태를 순서와 관계없이 선택할 수 있습니다.';
    buttons.forEach(button => {
      const sourceCompletion = latest?.sourceData && !customerDemo && button.dataset.scenario === 'completed';
      button.disabled = unavailable || pending || Boolean(sourceCompletion) || Boolean(latest?.sourceData && !customerDemo && target?.status === 'done');
      button.title = sourceCompletion ? '배송원 뷰어에서 사진 확인 후 완료할 수 있습니다.' : '';
      button.setAttribute('aria-pressed', String(button.dataset.scenario === activeScenario));
    });
  }

  nextButton.addEventListener('click', () => {
    if (nextButton.disabled) return;
    const next = nextScenarioTarget(latest, selectedId);
    if (next) onSelect(next.id);
  });

  for (const [button, type] of [[randomButton, 'randomize_customer_position'], [resetButton, 'reset_customer_demo']]) {
    button.addEventListener('click', () => {
      const target = selectedScenarioTarget(latest, selectedId);
      if (button.disabled || !latest?.customerDemo || !target) return;
      onSend(type, { stopId: target.id });
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
    if (!scenarioSelectionState(latest, target, connected).controllable) return;
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
