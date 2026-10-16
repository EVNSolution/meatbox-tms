import { createResourceClient } from './resource-client.mjs';
import { plateLabel } from './vehicle-identity.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const codePattern = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

export function resourceManagementModel(snapshot, { query = '', statusFilter = '', drafts = new Map(), drivers = new Map() } = {}) {
  const vehicles = (Array.isArray(snapshot?.vehicles) ? snapshot.vehicles : []).map(vehicle => ({
    ...vehicle, effectiveRegionCode: drafts.has(vehicle.id) ? drafts.get(vehicle.id) : vehicle.regionCode,
    changed: drafts.has(vehicle.id),
  }));
  const counts = new Map();
  for (const vehicle of vehicles) if (vehicle.regionCode) counts.set(vehicle.regionCode, (counts.get(vehicle.regionCode) || 0) + 1);
  const regionCodes = (Array.isArray(snapshot?.regionCodes) ? snapshot.regionCodes : []).map(item => ({ code: item.code, vehicleCount: counts.get(item.code) || 0 }));
  const allowed = new Set(regionCodes.map(item => item.code));
  const invalidIds = new Set(vehicles.filter(vehicle => vehicle.effectiveRegionCode && !allowed.has(vehicle.effectiveRegionCode)).map(vehicle => vehicle.id));
  const needle = String(query).trim().toLocaleLowerCase('ko-KR');
  const visibleVehicles = vehicles.filter(vehicle => {
    if (statusFilter === 'unassigned' && vehicle.regionCode) return false;
    if (statusFilter === 'assigned' && !vehicle.regionCode) return false;
    return !needle || [vehicle.id, vehicle.plate, vehicle.regionCode, vehicle.effectiveRegionCode, drivers.get(vehicle.id)].some(value => String(value ?? '').toLocaleLowerCase('ko-KR').includes(needle));
  });
  return { vehicles, visibleVehicles, regionCodes, invalidIds };
}

const options = (regionCodes, value) => `<option value="" ${value == null ? 'selected' : ''}>미지정</option>${regionCodes.map(item => `<option value="${escapeHtml(item.code)}" ${item.code === value ? 'selected' : ''}>${escapeHtml(item.code)}</option>`).join('')}`;

export function mountResourceManagement({ element, client = createResourceClient(), assignmentClient = null, onEmptyChange = () => {} }) {
  if (!element) throw new TypeError('자원 관리 영역이 필요합니다.');
  let query = '';
  let statusFilter = '';
  let regionsOpen = false;
  let regionInputDraft = null;
  let loading = false;
  let loadFailed = false;
  let saving = false;
  let stale = false;
  let error = '';
  let confirmDiscard = false;
  let reportedEmpty;
  // Who drives which vehicle is a separate list with its own revision. It is saved row by row, at once, because the
  // driver's phone follows it at once; a release asks first.
  let assignState = assignmentClient ? 'loading' : 'off';
  let assignError = '';
  let release = null;
  const rowState = new Map();
  const drafts = new Map();
  const draftBaselines = new Map();

  const hasKnownData = () => Boolean(client.snapshot) && !loading && !loadFailed;
  const canEdit = () => hasKnownData() && !saving && !stale;
  const assigned = () => new Map((assignmentClient?.snapshot?.assignments || []).map(item => [item.vehicleId, item.driver]));
  const searchText = () => new Map([...assigned()].map(([id, driver]) => [id, `${driver} ${assignmentClient.snapshot.drivers.find(item => item.username === driver)?.displayName || ''}`]));

  function driverCell(vehicle) {
    if (assignState === 'off') return '';
    if (assignState !== 'ready') return `<td class="resource-driver" data-resource-driver-state="${assignState}">${assignState === 'loading' ? '불러오는 중' : '미확인'}</td>`;
    const { drivers } = assignmentClient.snapshot;
    const current = assigned().get(vehicle.id) ?? null;
    const account = drivers.find(item => item.username === current);
    const broken = current !== null && (!account || account.disabled);
    const status = rowState.get(vehicle.id);
    const busy = status?.kind === 'saving' || release !== null;
    const choices = drivers.filter(item => !item.disabled).map(item => `<option value="${escapeHtml(item.username)}" ${item.username === current ? 'selected' : ''}>${escapeHtml(item.displayName)} (${escapeHtml(item.username)})</option>`).join('');
    const orphan = broken ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (${account ? '비활성 계정' : '계정 없음'})</option>` : '';
    const note = status ? `<small class="resource-driver-state" data-kind="${status.kind}" role="status">${escapeHtml(status.text)}</small>`
      : broken ? '<small class="resource-driver-state" data-kind="warn">이 계정으로는 기사 앱을 쓸 수 없습니다. 다른 기사에게 배정하거나 해제해 주세요.</small>' : '';
    return `<td class="resource-driver"><select data-resource-driver-select="${escapeHtml(vehicle.id)}" aria-label="${escapeHtml(plateLabel(vehicle))} 담당 기사" aria-invalid="${broken}" ${busy ? 'disabled' : ''}><option value="" ${current === null ? 'selected' : ''}>미배정</option>${choices}${orphan}</select>${note}</td>`;
  }

  function render(focusId, caret) {
    const scrollTop = element.querySelector?.('.resource-table-scroll')?.scrollTop || 0;
    const known = hasKnownData();
    const model = resourceManagementModel(known ? client.snapshot : null, { query, statusFilter, drafts, drivers: searchText() });
    const editable = canEdit();
    const disabled = editable ? '' : 'disabled';
    const locked = !editable || drafts.size > 0;
    const validation = model.invalidIds.size ? '선택한 지역 코드가 등록부에 없습니다. 다시 불러오거나 변경을 취소해 주세요.' : '';
    const counts = known ? `표시 ${model.visibleVehicles.length} / 전체 ${model.vehicles.length}대 / 미지정 ${model.vehicles.filter(vehicle => !vehicle.regionCode).length}대${assignState === 'ready' ? ` / 기사 미배정 ${model.vehicles.filter(vehicle => !assigned().has(vehicle.id)).length}대` : ''}` : '표시 미확인 / 전체 미확인 / 미지정 미확인';
    const emptyLabel = !known ? '미확인' : model.vehicles.length ? '검색 결과 없음' : '미등록';
    element.innerHTML = `<section class="resource-management" aria-label="자원 관리">
      <div class="resource-toolbar">
        <div class="resource-toolbar-actions">
          <label>검색<input type="search" data-resource-search value="${escapeHtml(query)}" placeholder="차량번호 또는 지역 코드" ${disabled}></label>
          <label>지역 지정 상태<select data-resource-status-filter ${disabled}><option value="">전체</option><option value="assigned" ${statusFilter === 'assigned' ? 'selected' : ''}>지정</option><option value="unassigned" ${statusFilter === 'unassigned' ? 'selected' : ''}>미지정</option></select></label>
          <div class="resource-region-action"><button type="button" class="button subtle" data-resource-action="regions" aria-expanded="${regionsOpen}" aria-controls="resource-region-panel" ${known ? '' : 'disabled'}>지역 코드 관리</button>
          ${regionsOpen ? `<section id="resource-region-panel" class="resource-region-panel" data-resource-region-panel aria-label="지역 코드 관리"><div class="resource-region-heading"><h2 tabindex="-1">지역 코드 관리</h2><button type="button" class="button subtle" data-resource-action="regions">닫기</button></div><p id="resource-code-hint">영문과 숫자 지역 코드</p>${drafts.size ? '<p class="resource-region-lock">차량 변경을 저장하거나 취소한 후 지역 코드를 편집할 수 있습니다.</p>' : ''}<form data-resource-form="create"><label>새 코드<input name="code" value="${escapeHtml(regionInputDraft?.action === 'create' ? regionInputDraft.value : '')}" required maxlength="40" pattern="[A-Za-z][A-Za-z0-9]{0,39}" aria-describedby="resource-code-hint" ${locked ? 'disabled' : ''}></label><button type="submit" class="button" ${locked ? 'disabled' : ''}>추가</button></form><div class="resource-region-list">${model.regionCodes.map(item => `<form data-resource-form="rename" data-code="${escapeHtml(item.code)}"><label><span class="sr-only">${escapeHtml(item.code)} 코드 변경</span><input name="code" value="${escapeHtml(regionInputDraft?.action === 'rename' && regionInputDraft.oldCode === item.code ? regionInputDraft.value : item.code)}" required maxlength="40" pattern="[A-Za-z][A-Za-z0-9]{0,39}" ${locked ? 'disabled' : ''}></label><span>${item.vehicleCount}대</span><button type="submit" class="button subtle" aria-label="${escapeHtml(item.code)} 코드 변경 저장" ${locked ? 'disabled' : ''}>변경</button></form>`).join('')}</div></section>` : ''}</div>
        </div>
        <div class="resource-toolbar-meta"><span class="resource-count">${counts}</span></div>
      </div>
      <p class="resource-message" role="status" aria-live="polite">${escapeHtml(error || validation || (loading ? '자원 자료를 불러오고 있습니다.' : saving ? '저장하고 있습니다.' : ''))}</p>
      ${assignState === 'error' ? `<p class="resource-message resource-driver-message" role="status">${escapeHtml(assignError)}</p><button type="button" class="button subtle resource-reload" data-resource-action="refresh-drivers">기사 배정 다시 불러오기</button>` : ''}
      ${assignState === 'ready' && !assignmentClient.snapshot.drivers.length ? '<p class="resource-message resource-driver-message">기사 계정이 없습니다. 운영 절차의 기사 초대로 계정을 만든 뒤 다시 불러와 주세요.</p>' : ''}
      ${error || validation ? `<button type="button" class="button subtle resource-reload" data-resource-action="refresh" ${loading || saving ? 'disabled' : ''}>다시 불러오기</button>` : ''}
      <div class="resource-table-scroll" aria-busy="${loading}"><table class="resource-table"><thead><tr><th scope="col">지역 코드</th><th scope="col">차량번호</th><th scope="col">지정 상태</th>${assignState === 'off' ? '' : '<th scope="col">기사</th>'}<th scope="col">변경</th></tr></thead><tbody>${model.visibleVehicles.length ? model.visibleVehicles.map(vehicle => `<tr data-resource-row="${escapeHtml(vehicle.id)}" ${vehicle.changed ? 'data-changed="true"' : ''} ${model.invalidIds.has(vehicle.id) ? 'data-invalid="true"' : ''}><td><select data-resource-region-select="${escapeHtml(vehicle.id)}" aria-label="${escapeHtml(plateLabel(vehicle))} 지역 코드" aria-invalid="${model.invalidIds.has(vehicle.id)}" ${disabled}>${options(model.regionCodes, vehicle.effectiveRegionCode)}</select></td><th scope="row">${escapeHtml(plateLabel(vehicle))}</th><td>${vehicle.effectiveRegionCode ? '지정' : '미지정'}</td>${driverCell(vehicle)}<td class="resource-row-state">${model.invalidIds.has(vehicle.id) ? '코드 확인' : vehicle.changed ? '변경' : ''}</td></tr>`).join('') : `<tr><td class="resource-empty" colspan="${assignState === 'off' ? 4 : 5}">${emptyLabel}</td></tr>`}</tbody></table></div>
      <div class="resource-actionbar"><span>변경 ${drafts.size}건</span><div><button type="button" class="button subtle" data-resource-action="discard" ${drafts.size && !loading && !saving ? '' : 'disabled'}>변경 취소</button><button type="button" class="button primary" data-resource-action="save" ${drafts.size && editable && !validation ? '' : 'disabled'}>변경 ${drafts.size}건 저장</button></div></div>
      ${release ? `<div class="resource-confirm" role="group" aria-label="기사 배정 해제 확인"><span>${escapeHtml(release.driver)} 기사에게서 ${escapeHtml(release.plate)} 차량을 해제합니다. 기사 앱에서 이 차량을 바로 볼 수 없게 됩니다.</span><button type="button" class="button" data-resource-action="confirm-release">해제 확인</button><button type="button" class="button subtle" data-resource-action="cancel-release">취소</button></div>` : ''}
      ${confirmDiscard ? `<div class="resource-confirm" role="group" aria-label="변경 취소 확인"><span>임시 변경 ${drafts.size}건을 취소하시겠습니까?</span><button type="button" class="button" data-resource-action="confirm-discard">변경 취소 확인</button><button type="button" class="button subtle" data-resource-action="keep-drafts">계속 편집</button></div>` : ''}
    </section>`;
    const scroller = element.querySelector?.('.resource-table-scroll');
    if (scroller) scroller.scrollTop = scrollTop;
    const empty = known && model.vehicles.length === 0;
    if (empty !== reportedEmpty) { reportedEmpty = empty; onEmptyChange(empty); }
    if (typeof focusId === 'string' && focusId.startsWith('driver:')) {
      [...(element.querySelectorAll?.('[data-resource-driver-select]') || [])].find(item => item.dataset.resourceDriverSelect === focusId.slice(7))?.focus();
    } else if (focusId === 'filter') element.querySelector?.('[data-resource-status-filter]')?.focus();
    else if (focusId === 'search') {
      const search = element.querySelector?.('[data-resource-search]');
      search?.focus();
      if (Number.isInteger(caret)) search?.setSelectionRange(caret, caret);
    } else if (focusId) {
      [...(element.querySelectorAll?.('[data-resource-region-select]') || [])].find(item => item.dataset.resourceRegionSelect === focusId)?.focus();
    }
  }

  async function loadAssignments() {
    if (!assignmentClient) return;
    assignState = 'loading'; assignError = ''; render();
    try { await assignmentClient.load(); assignState = 'ready'; }
    catch (cause) { assignState = 'error'; assignError = cause.message || '기사 배정을 불러오지 못했습니다.'; }
    render();
  }

  async function saveDriver(vehicleId, driver) {
    rowState.set(vehicleId, { kind: 'saving', text: '저장 중' }); render();
    try {
      await assignmentClient.assign(vehicleId, driver || null);
      rowState.set(vehicleId, { kind: 'saved', text: driver ? '저장됨. 기사 앱에 바로 적용됩니다.' : '해제됨. 기사 앱에서 바로 막혔습니다.' });
    } catch (cause) {
      rowState.set(vehicleId, { kind: 'failed', text: cause.message || '저장하지 못했습니다.' });
    }
    render(`driver:${vehicleId}`);
  }

  function changeDriver(vehicleId, value) {
    const vehicle = client.snapshot?.vehicles.find(item => item.id === vehicleId);
    const current = assigned().get(vehicleId) ?? null;
    rowState.delete(vehicleId);
    if (!vehicle || value === (current ?? '')) return render(`driver:${vehicleId}`);
    if (!value) { release = { vehicleId, driver: current, plate: plateLabel(vehicle) }; return render(`driver:${vehicleId}`); }
    return saveDriver(vehicleId, value);
  }

  function setDraft(id, code) {
    const vehicle = client.snapshot?.vehicles.find(item => item.id === id);
    if (!vehicle) return;
    if (code && !client.snapshot.regionCodes.some(item => item.code === code)) return;
    if (vehicle.regionCode === code) { drafts.delete(id); draftBaselines.delete(id); }
    else { drafts.set(id, code); if (!draftBaselines.has(id)) draftBaselines.set(id, vehicle.regionCode); }
    confirmDiscard = false;
    if (!stale) error = '';
  }

  async function load() {
    if (loading || saving) return;
    loading = true; error = ''; render();
    try {
      await client.load();
      loadFailed = false;
      stale = [...drafts].some(([id, code]) => {
        const vehicle = client.snapshot.vehicles.find(item => item.id === id);
        return !vehicle || vehicle.regionCode !== draftBaselines.get(id) || code && !client.snapshot.regionCodes.some(item => item.code === code);
      });
      if (stale) error = '다른 변경과 겹치는 임시 변경이 있습니다. 변경을 취소한 뒤 다시 편집해 주세요.';
    } catch (cause) { loadFailed = true; error = cause.message || '자원 자료를 불러오지 못했습니다.'; }
    finally { loading = false; render(); }
  }

  async function save() {
    const model = resourceManagementModel(client.snapshot, { drafts });
    if (!canEdit() || !drafts.size || model.invalidIds.size) return;
    saving = true; confirmDiscard = false; error = ''; render();
    try {
      await client.assignVehicles([...drafts].map(([id, regionCode]) => ({ id, regionCode })));
      drafts.clear(); draftBaselines.clear(); stale = false;
    } catch (cause) {
      loadFailed = true;
      error = cause.message || '저장하지 못했습니다.';
      if (cause.code === 'RESOURCE_REVISION_CONFLICT') stale = true;
    } finally { saving = false; render(); }
  }

  async function onSubmit(event) {
    const form = event.target.closest?.('[data-resource-form]');
    if (!form) return;
    event.preventDefault();
    if (!canEdit() || drafts.size) return;
    regionInputDraft = { action: form.dataset.resourceForm, oldCode: form.dataset.code, value: form.elements.code.value };
    const code = form.elements.code.value.trim().toUpperCase();
    if (!codePattern.test(code)) { error = '영문자로 시작하는 영문과 숫자 지역 코드만 입력해 주세요.'; render(); return; }
    saving = true; error = ''; render();
    try {
      if (form.dataset.resourceForm === 'create') await client.createRegionCode(code);
      else await client.renameRegionCode(form.dataset.code, code);
      regionInputDraft = null;
    } catch (cause) { loadFailed = true; error = cause.message || '지역 코드를 저장하지 못했습니다.'; }
    finally { saving = false; render(); }
  }

  function onInput(event) {
    if (!canEdit() || event.target.dataset.resourceSearch === undefined) return;
    query = event.target.value;
    render('search', event.target.selectionStart);
  }

  function onChange(event) {
    const target = event.target;
    if (target.dataset.resourceDriverSelect !== undefined) { if (assignState === 'ready') void changeDriver(target.dataset.resourceDriverSelect, target.value); return; }
    if (!canEdit()) return;
    if (target.dataset.resourceRegionSelect !== undefined) {
      setDraft(target.dataset.resourceRegionSelect, target.value || null);
      render(target.dataset.resourceRegionSelect);
    } else if (target.dataset.resourceStatusFilter !== undefined) {
      statusFilter = target.value;
      render('filter');
    }
  }

  function onClick(event) {
    const action = event.target.closest?.('[data-resource-action]')?.dataset.resourceAction;
    if (!action) return;
    if (action === 'refresh') return Promise.all([load(), loadAssignments()]);
    if (action === 'refresh-drivers') return loadAssignments();
    if (action === 'cancel-release') { release = null; render(); return; }
    if (action === 'confirm-release') { const target = release; release = null; if (target) void saveDriver(target.vehicleId, ''); return; }
    if (action === 'save') return save();
    if (action === 'regions') {
      if (!regionsOpen && !hasKnownData()) return;
      regionsOpen = !regionsOpen; render();
      element.querySelector?.(regionsOpen ? '#resource-region-panel input:not(:disabled), #resource-region-panel h2' : '[data-resource-action="regions"]')?.focus();
      return;
    }
    if (loading || saving) return;
    if (action === 'discard' && drafts.size) { confirmDiscard = true; render(); }
    else if (action === 'keep-drafts') { confirmDiscard = false; render(); }
    else if (action === 'confirm-discard') { drafts.clear(); draftBaselines.clear(); confirmDiscard = false; stale = false; if (!loadFailed) error = ''; render(); }
  }

  element.addEventListener('submit', onSubmit);
  element.addEventListener('input', onInput);
  element.addEventListener('change', onChange);
  element.addEventListener('click', onClick);
  render();
  void load();
  void loadAssignments();
  return { refresh: () => Promise.all([load(), loadAssignments()]), destroy() { element.removeEventListener('submit', onSubmit); element.removeEventListener('input', onInput); element.removeEventListener('change', onChange); element.removeEventListener('click', onClick); } };
}
