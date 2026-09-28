import { createResourceClient } from './resource-client.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const codePattern = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

export function resourceManagementModel(snapshot, { query = '', statusFilter = '', drafts = new Map() } = {}) {
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
    return !needle || [vehicle.id, vehicle.plate, vehicle.regionCode, vehicle.effectiveRegionCode].some(value => String(value ?? '').toLocaleLowerCase('ko-KR').includes(needle));
  });
  return { vehicles, visibleVehicles, regionCodes, invalidIds };
}

const options = (regionCodes, value) => `<option value="" ${value == null ? 'selected' : ''}>미지정</option>${regionCodes.map(item => `<option value="${escapeHtml(item.code)}" ${item.code === value ? 'selected' : ''}>${escapeHtml(item.code)}</option>`).join('')}`;

export function mountResourceManagement({ element, client = createResourceClient() }) {
  if (!element) throw new TypeError('자원 관리 영역이 필요합니다.');
  let query = '';
  let statusFilter = '';
  let regionsOpen = false;
  let regionInputDraft = null;
  let loading = false;
  let saving = false;
  let stale = false;
  let error = '';
  let confirmDiscard = false;
  const drafts = new Map();
  const draftBaselines = new Map();

  function render(focusId, caret) {
    const scrollTop = element.querySelector?.('.resource-table-scroll')?.scrollTop || 0;
    const model = resourceManagementModel(client.snapshot, { query, statusFilter, drafts });
    const editable = Boolean(client.snapshot) && !loading && !saving;
    const disabled = editable ? '' : 'disabled';
    const locked = !editable || drafts.size > 0;
    const validation = model.invalidIds.size ? '선택한 지역 코드가 등록부에 없습니다. 다시 불러오거나 변경을 취소해 주세요.' : '';
    element.innerHTML = `<section class="resource-management" aria-label="자원 관리">
      <div class="resource-toolbar">
        <label>검색<input type="search" data-resource-search value="${escapeHtml(query)}" placeholder="차량번호 또는 지역 코드" ${disabled}></label>
        <label>지역 지정 상태<select data-resource-status-filter ${disabled}><option value="">전체</option><option value="assigned" ${statusFilter === 'assigned' ? 'selected' : ''}>지정</option><option value="unassigned" ${statusFilter === 'unassigned' ? 'selected' : ''}>미지정</option></select></label>
        <span class="resource-count">표시 ${model.visibleVehicles.length} / 전체 ${model.vehicles.length}대 · 미지정 ${model.vehicles.filter(vehicle => !vehicle.regionCode).length}대</span>
        <button type="button" class="button subtle" data-resource-action="regions" aria-expanded="${regionsOpen}" aria-controls="resource-region-panel">지역 코드 관리</button>
      </div>
      <p class="resource-message" role="status" aria-live="polite">${escapeHtml(error || validation || (loading ? '자원 자료를 불러오고 있습니다.' : saving ? '저장하고 있습니다.' : ''))}</p>
      ${error ? '<button type="button" class="button subtle resource-reload" data-resource-action="refresh">다시 불러오기</button>' : ''}
      ${client.snapshot ? `<div class="resource-table-scroll"><table class="resource-table"><thead><tr><th scope="col">지역 코드</th><th scope="col">차량번호</th><th scope="col">지정 상태</th><th scope="col">변경</th></tr></thead><tbody>${model.visibleVehicles.length ? model.visibleVehicles.map(vehicle => `<tr data-resource-row="${escapeHtml(vehicle.id)}" ${vehicle.changed ? 'data-changed="true"' : ''} ${model.invalidIds.has(vehicle.id) ? 'data-invalid="true"' : ''}><td><select data-resource-region-select="${escapeHtml(vehicle.id)}" aria-label="${escapeHtml(vehicle.plate)} 지역 코드" aria-invalid="${model.invalidIds.has(vehicle.id)}" ${disabled}>${options(model.regionCodes, vehicle.effectiveRegionCode)}</select></td><th scope="row">${escapeHtml(vehicle.plate)}</th><td>${vehicle.effectiveRegionCode ? '지정' : '미지정'}</td><td class="resource-row-state">${model.invalidIds.has(vehicle.id) ? '코드 확인' : vehicle.changed ? '변경' : ''}</td></tr>`).join('') : '<tr><td class="resource-empty" colspan="4">조회할 차량이 없습니다.</td></tr>'}</tbody></table></div>
      <div class="resource-actionbar"><span>변경 ${drafts.size}건</span><div><button type="button" class="button subtle" data-resource-action="discard" ${drafts.size && editable ? '' : 'disabled'}>변경 취소</button><button type="button" class="button primary" data-resource-action="save" ${drafts.size && editable && !stale && !validation ? '' : 'disabled'}>변경 ${drafts.size}건 저장</button></div></div>` : '<p class="resource-empty">자원 자료를 불러온 후 차량을 표시합니다.</p>'}
      ${confirmDiscard ? `<div class="resource-confirm" role="group" aria-label="변경 취소 확인"><span>임시 변경 ${drafts.size}건을 취소하시겠습니까?</span><button type="button" class="button" data-resource-action="confirm-discard">변경 취소 확인</button><button type="button" class="button subtle" data-resource-action="keep-drafts">계속 편집</button></div>` : ''}
      ${regionsOpen ? `<section id="resource-region-panel" class="resource-region-panel" data-resource-region-panel aria-label="지역 코드 관리"><div class="resource-region-heading"><h2 tabindex="-1">지역 코드 관리</h2><button type="button" class="button subtle" data-resource-action="regions">닫기</button></div><p id="resource-code-hint">영문·숫자 지역 코드</p>${drafts.size ? '<p class="resource-region-lock">차량 변경을 저장하거나 취소한 후 지역 코드를 편집할 수 있습니다.</p>' : ''}<form data-resource-form="create"><label>새 코드<input name="code" value="${escapeHtml(regionInputDraft?.action === 'create' ? regionInputDraft.value : '')}" required maxlength="40" pattern="[A-Za-z][A-Za-z0-9]{0,39}" aria-describedby="resource-code-hint" ${locked ? 'disabled' : ''}></label><button type="submit" class="button" ${locked ? 'disabled' : ''}>추가</button></form><div class="resource-region-list">${model.regionCodes.map(item => `<form data-resource-form="rename" data-code="${escapeHtml(item.code)}"><label><span class="sr-only">${escapeHtml(item.code)} 코드 변경</span><input name="code" value="${escapeHtml(regionInputDraft?.action === 'rename' && regionInputDraft.oldCode === item.code ? regionInputDraft.value : item.code)}" required maxlength="40" pattern="[A-Za-z][A-Za-z0-9]{0,39}" ${locked ? 'disabled' : ''}></label><span>${item.vehicleCount}대</span><button type="submit" class="button subtle" aria-label="${escapeHtml(item.code)} 코드 변경 저장" ${locked ? 'disabled' : ''}>변경</button></form>`).join('')}</div></section>` : ''}
    </section>`;
    const scroller = element.querySelector?.('.resource-table-scroll');
    if (scroller) scroller.scrollTop = scrollTop;
    if (focusId === 'filter') element.querySelector?.('[data-resource-status-filter]')?.focus();
    else if (focusId === 'search') {
      const search = element.querySelector?.('[data-resource-search]');
      search?.focus();
      if (Number.isInteger(caret)) search?.setSelectionRange(caret, caret);
    } else if (focusId) {
      [...(element.querySelectorAll?.('[data-resource-region-select]') || [])].find(item => item.dataset.resourceRegionSelect === focusId)?.focus();
    }
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
      stale = [...drafts].some(([id, code]) => {
        const vehicle = client.snapshot.vehicles.find(item => item.id === id);
        return !vehicle || vehicle.regionCode !== draftBaselines.get(id) || code && !client.snapshot.regionCodes.some(item => item.code === code);
      });
      if (stale) error = '다른 변경과 겹치는 임시 변경이 있습니다. 변경을 취소한 뒤 다시 편집해 주세요.';
    } catch (cause) { error = cause.message || '자원 자료를 불러오지 못했습니다.'; }
    finally { loading = false; render(); }
  }

  async function save() {
    const model = resourceManagementModel(client.snapshot, { drafts });
    if (saving || loading || stale || !drafts.size || model.invalidIds.size) return;
    saving = true; confirmDiscard = false; error = ''; render();
    try {
      await client.assignVehicles([...drafts].map(([id, regionCode]) => ({ id, regionCode })));
      drafts.clear(); draftBaselines.clear(); stale = false;
    } catch (cause) {
      error = cause.message || '저장하지 못했습니다.';
      if (cause.code === 'RESOURCE_REVISION_CONFLICT') stale = true;
    } finally { saving = false; render(); }
  }

  async function onSubmit(event) {
    const form = event.target.closest?.('[data-resource-form]');
    if (!form) return;
    event.preventDefault();
    if (loading || saving || drafts.size) return;
    regionInputDraft = { action: form.dataset.resourceForm, oldCode: form.dataset.code, value: form.elements.code.value };
    const code = form.elements.code.value.trim().toUpperCase();
    if (!codePattern.test(code)) { error = '영문자로 시작하는 영문·숫자 지역 코드만 입력해 주세요.'; render(); return; }
    saving = true; error = ''; render();
    try {
      if (form.dataset.resourceForm === 'create') await client.createRegionCode(code);
      else await client.renameRegionCode(form.dataset.code, code);
      regionInputDraft = null;
    } catch (cause) { error = cause.message || '지역 코드를 저장하지 못했습니다.'; }
    finally { saving = false; render(); }
  }

  function onInput(event) {
    if (loading || saving || event.target.dataset.resourceSearch === undefined) return;
    query = event.target.value;
    render('search', event.target.selectionStart);
  }

  function onChange(event) {
    if (loading || saving) return;
    const target = event.target;
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
    if (action === 'refresh') return load();
    if (action === 'save') return save();
    if (action === 'regions') {
      regionsOpen = !regionsOpen; render();
      element.querySelector?.(regionsOpen ? '#resource-region-panel input:not(:disabled), #resource-region-panel h2' : '[data-resource-action="regions"]')?.focus();
      return;
    }
    if (loading || saving) return;
    if (action === 'discard' && drafts.size) { confirmDiscard = true; render(); }
    else if (action === 'keep-drafts') { confirmDiscard = false; render(); }
    else if (action === 'confirm-discard') { drafts.clear(); draftBaselines.clear(); confirmDiscard = false; stale = false; error = ''; render(); }
  }

  element.addEventListener('submit', onSubmit);
  element.addEventListener('input', onInput);
  element.addEventListener('change', onChange);
  element.addEventListener('click', onClick);
  render();
  void load();
  return { refresh: load, destroy() { element.removeEventListener('submit', onSubmit); element.removeEventListener('input', onInput); element.removeEventListener('change', onChange); element.removeEventListener('click', onClick); } };
}
