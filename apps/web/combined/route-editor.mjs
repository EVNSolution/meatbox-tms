import { calculatedEtaText } from './simulation-adapter.mjs';
import { referenceIcon } from './reference-icons.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const labels = { pending: '대기', current: '배송 중', done: '완료', skipped: '보류' };
const childOrders = stop => Array.isArray(stop?.orders) && stop.orders.length ? stop.orders : [stop];
const rawBaseline = deliveries => deliveries.flatMap(childOrders).map(order => [order.id, order.status]);
const signature = state => JSON.stringify([state.phase, rawBaseline(state.deliveries)]);

export const routeEditability = state => state?.vehicle?.live === false
  ? { editable: false, reason: '조회 전용 차량은 배송 순서를 편집할 수 없습니다.' }
  : { editable: true, reason: '' };

export function movePendingOrder(order, deliveries, id, targetId) {
  const pending = new Set(deliveries.filter(stop => stop.status === 'pending').map(stop => stop.id));
  if (!pending.has(id) || !pending.has(targetId)) return [...order];
  const movable = order.filter(stopId => pending.has(stopId));
  const from = movable.indexOf(id), to = movable.indexOf(targetId);
  if (from < 0 || to < 0) return [...order];
  movable.splice(to, 0, movable.splice(from, 1)[0]);
  let cursor = 0;
  return order.map(stopId => pending.has(stopId) ? movable[cursor++] : stopId);
}

export function routeSelectionId(element, target) {
  const selection = target.closest('[data-route-select]');
  if (selection) return element.contains(selection) ? selection.dataset.routeSelect : null;
  if (target.closest('button')) return null;
  const row = target.closest('[data-route-id]');
  return row && element.contains(row) ? row.dataset.routeId : null;
}

export function mountRouteEditor({ element, onSend, onSelect, onCancel = () => {} }) {
  let latest, selectedId, connected = false, draft = null, base = null, pending = false, drag = null;
  let message = '', error = false, rendered = '', renderedVehicleId = null;
  const order = () => latest?.deliveries.map(stop => stop.id) || [];
  const changed = () => draft && draft.some((id, index) => id !== base.order[index]);

  function finish(text, isError = false) {
    draft = null; base = null; pending = false; message = text; error = isError;
  }
  function resetDraft() {
    draft = order();
    const raw = rawBaseline(latest.deliveries);
    base = { order: order(), rawOrder: raw.map(item => item[0]), rawStatuses: raw.map(item => item[1]), phase: latest.phase, signature: signature(latest) };
  }
  function beginEdit() {
    if (!latest || !connected || draft || !routeEditability(latest).editable || latest.deliveries.filter(stop => stop.status === 'pending').length < 2) return;
    resetDraft();
    message = ''; error = false;
    render();
  }
  function cancel() {
    if (pending) return;
    finish('변경을 취소했습니다. 기존 배송 순서를 유지합니다.');
    render();
    onCancel();
  }
  function render() {
    if (!latest || drag) return;
    const access = routeEditability(latest);
    const rows = (draft || order()).map(id => latest.deliveries.find(stop => stop.id === id));
    const key = JSON.stringify([rows.map(stop => [stop.id, stop.status, stop.officialEta?.time]), selectedId, !!draft, pending, connected, message, error]);
    if (key === rendered) return;
    rendered = key;
    const focused = element.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null;
    const scrollTop = renderedVehicleId === latest.vehicle?.id ? element.querySelector('.route-list')?.scrollTop || 0 : 0;
    renderedVehicleId = latest.vehicle?.id;
    element.innerHTML = `
      <div class="route-heading"><div><h2>차량 배송 순서</h2><p><span>${escapeHtml(latest.vehicle?.plate)}</span><span>${escapeHtml(latest.vehicle?.driver)}</span><span>${rows.length}곳</span>${access.editable ? '' : '<span>조회 전용</span>'}</p></div><div class="route-edit-actions"><button class="button subtle" data-route-action="cancel" data-focus="cancel" ${pending ? 'disabled' : ''}>취소</button><button class="button subtle" data-route-action="reset" data-focus="reset" ${!changed() || pending || !connected ? 'disabled' : ''}>초기화</button>${draft
        ? `<button class="button primary" data-route-action="save" data-focus="save" ${!changed() || pending || !connected ? 'disabled' : ''}>${pending ? '저장 중…' : '저장'}</button>`
        : `<button class="button" data-route-action="edit" data-focus="edit" ${!access.editable || !connected || rows.filter(stop => stop.status === 'pending').length < 2 ? 'disabled' : ''}>순서 편집</button>`}</div></div>
      <p class="route-help">${access.reason || (draft ? '손잡이를 끌거나 위아래 버튼으로 순서를 바꾼 뒤 저장하세요. 배송 중, 완료, 보류 행은 고정됩니다.' : '배송지를 눌러 선택하세요. 순서를 바꾸려면 ‘순서 편집’을 누르세요.')}</p>
      <ol class="route-list" tabindex="0" aria-label="차량 배송 순서 목록">${rows.map((stop, index) => {
        const movable = draft && stop.status === 'pending';
        const eligible = rows.filter(row => row.status === 'pending');
        const place = eligible.findIndex(row => row.id === stop.id);
        const canHold = access.editable && stop.id !== latest.customerStopId && ['pending', 'skipped'].includes(stop.status);
        return `<li class="route-row${draft ? ' editing' : ''}${stop.id === selectedId ? ' selected' : ''}" data-route-id="${stop.id}">
          ${draft ? `<button class="route-handle" data-handle="${stop.id}" data-focus="handle-${stop.id}" aria-label="${escapeHtml(stop.name)} 순서 이동" title="끌어서 이동하거나 위아래 방향키 사용" ${!movable || pending || !connected ? 'disabled' : ''}>${referenceIcon('handle')}</button>` : ''}
          <span class="route-number">${index + 1}</span><button class="route-select" data-route-select="${stop.id}" data-focus="select-${stop.id}" aria-pressed="${stop.id === selectedId}" title="${escapeHtml(stop.address)}"><strong>${escapeHtml(stop.name)}</strong><span class="route-meta"><span class="badge ${stop.statusTone}">${labels[stop.status]}</span><small>ETA ${escapeHtml(stop.preciseTimeText || calculatedEtaText(stop))}</small>${draft && index !== stop.sequence - 1 ? `<span class="route-draft">${stop.sequence} → ${index + 1}번째</span>` : ''}</span></button>
          <div class="route-row-actions">${draft ? movable ? `<button class="route-move" data-move="${stop.id}" data-direction="-1" data-focus="up-${stop.id}" aria-label="${escapeHtml(stop.name)} 위로" ${place === 0 || pending || !connected ? 'disabled' : ''}>${referenceIcon('up')}</button><button class="route-move" data-move="${stop.id}" data-direction="1" data-focus="down-${stop.id}" aria-label="${escapeHtml(stop.name)} 아래로" ${place === eligible.length - 1 || pending || !connected ? 'disabled' : ''}>${referenceIcon('down')}</button>` : '<span class="route-locked">고정</span>' : canHold ? `<button class="route-hold" data-hold="${stop.id}" data-focus="hold-${stop.id}" ${!connected ? 'disabled' : ''}>${stop.status === 'skipped' ? '복원' : '보류'}</button>` : ''}</div>
        </li>`;
      }).join('')}</ol><p class="route-message" role="status" data-error="${error}" ${message ? '' : 'hidden'}>${escapeHtml(message)}</p>`;
    element.querySelector('.route-list').scrollTop = scrollTop;
    if (focused) element.querySelector(`[data-focus="${focused}"]`)?.focus({ preventScroll: true });
  }

  function move(id, targetId) {
    if (!draft || pending || !connected) return;
    draft = movePendingOrder(draft, latest.deliveries, id, targetId);
    message = '아직 저장하지 않은 순서입니다.'; error = false;
    render();
  }
  function moveBy(id, direction) {
    if (!draft) return;
    const eligible = draft.filter(stopId => latest.deliveries.find(stop => stop.id === stopId)?.status === 'pending');
    const targetId = eligible[eligible.indexOf(id) + direction];
    if (targetId) move(id, targetId);
  }

  element.addEventListener('click', event => {
    const selectionId = routeSelectionId(element, event.target);
    if (selectionId) onSelect(selectionId);
    const action = event.target.closest('[data-route-action]')?.dataset.routeAction;
    if (action === 'edit') beginEdit();
    if (action === 'cancel') { cancel(); return; }
    if (action === 'reset' && draft && !pending && connected) {
      resetDraft(); message = '저장하지 않은 변경을 초기화했습니다.'; error = false;
    }
    if (action === 'save' && changed() && connected && !pending && routeEditability(latest).editable) {
      pending = true; message = '배송 순서를 저장하고 있습니다.';
      onSend('set_route_order', { order: draft, expectedOrder: base.rawOrder, expectedStatuses: base.rawStatuses, expectedPhase: base.phase });
    }
    const moving = event.target.closest('[data-move]');
    if (moving) moveBy(moving.dataset.move, Number(moving.dataset.direction));
    const hold = event.target.closest('[data-hold]');
    if (hold && connected && !draft && routeEditability(latest).editable) onSend('toggle_skip', { stopId: hold.dataset.hold });
    render();
  });
  element.addEventListener('keydown', event => {
    const handle = event.target.closest('[data-handle]');
    if (handle && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); moveBy(handle.dataset.handle, event.key === 'ArrowUp' ? -1 : 1);
    }
    if (event.key === 'Escape' && !pending) cancel();
  });
  element.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-handle]');
    if (!handle || handle.disabled || !event.isPrimary || event.button !== 0) return;
    event.preventDefault(); handle.focus(); handle.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, id: handle.dataset.handle, target: null };
  });
  element.addEventListener('pointermove', event => {
    if (drag?.pointer !== event.pointerId) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-route-id]');
    element.querySelectorAll('[data-drop]').forEach(item => item.removeAttribute('data-drop'));
    drag.target = row && element.contains(row) ? row.dataset.routeId : null;
    if (latest.deliveries.find(stop => stop.id === drag.target)?.status === 'pending') row.dataset.drop = 'true';
    const list = element.querySelector('.route-list');
    const bounds = list.getBoundingClientRect();
    if (event.clientY > bounds.bottom - 40) list.scrollBy(0, 16);
    if (event.clientY < bounds.top + 40) list.scrollBy(0, -16);
  });
  function endDrag(event) {
    if (drag?.pointer !== event.pointerId) return;
    const { id, target } = drag;
    drag = null;
    element.querySelectorAll('[data-drop]').forEach(item => item.removeAttribute('data-drop'));
    if (event.type === 'pointerup' && target) move(id, target);
    render();
  }
  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);

  return {
    beginEdit,
    clear() {
      latest = null; selectedId = null; connected = false; draft = null; base = null; pending = false; drag = null;
      message = ''; error = false; rendered = ''; renderedVehicleId = null;
      element.innerHTML = '';
    },
    update(state, selected, isConnected) {
      latest = state; selectedId = selected; connected = isConnected;
      if (pending && draft.every((id, index) => id === order()[index])) {
        pending = false; resetDraft();
        message = '배송 순서를 저장했습니다. ETA에 반영되었습니다.'; error = false;
      }
      else if (draft && (!connected || signature(state) !== base.signature)) finish('배송 진행이나 연결 상태가 바뀌어 편집을 종료했습니다. 최신 순서에서 다시 편집해 주세요.', true);
      render();
    },
    showError(text) {
      if (!pending) return false;
      pending = false; message = text; error = true; render();
      return true;
    },
  };
}
