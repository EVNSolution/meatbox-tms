import { referenceIcon } from './reference-icons.mjs';

const PHASE_LABELS = {
  unplanned: '배차 전',
  draft: '계산안',
  published: '배차 확정',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function amount(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value).toLocaleString('ko-KR') : '미등록';
}

function candidateKey(candidates) {
  return candidates.map(candidate => `${candidate.id}:${Boolean(candidate.locked)}`).sort().join('|');
}

function previewTable(rows) {
  if (!rows.length) return '';
  return `<div class="dispatch-workflow-table-wrap"><table><thead><tr><th scope="col">배송원</th><th scope="col">주문</th><th scope="col">배송지</th><th scope="col">박스</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${amount(row.orders)}</td><td>${amount(row.destinations)}</td><td>${amount(row.boxes)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function dispatchWorkflowModel(data, connected = true) {
  const dispatch = data?.dispatch || {};
  const candidates = Array.isArray(data?.dispatchCandidates)
    ? data.dispatchCandidates.filter(candidate => candidate?.id).map(candidate => ({ ...candidate, id: String(candidate.id) }))
    : [];
  const labels = new Map(candidates.map(candidate => [candidate.id, candidate.driver || candidate.plate || candidate.id]));
  const preview = Array.isArray(data?.dispatchPreview)
    ? data.dispatchPreview.filter(row => row?.vehicleId).map(row => ({ ...row, label: labels.get(String(row.vehicleId)) || String(row.vehicleId) }))
    : [];
  const readOnly = Boolean(dispatch.readOnly);
  const phase = PHASE_LABELS[dispatch.phase] ? dispatch.phase : 'unplanned';
  const draftVersion = Number.isInteger(dispatch.draftVersion) ? dispatch.draftVersion : null;
  const knownCandidateIds = new Set(candidates.map(candidate => candidate.id));
  return {
    date: data?.sourceData?.date || dispatch.today || '',
    candidates,
    preview,
    phase,
    phaseLabel: readOnly ? '과거 배차 기록' : PHASE_LABELS[phase],
    readOnly,
    canCalculate: Boolean(dispatch.canCalculate),
    candidateIds: Array.isArray(dispatch.candidateIds) ? dispatch.candidateIds.map(String).filter(id => knownCandidateIds.has(id)) : [],
    draftVersion,
    summary: dispatch.summary || {},
    canPublish: Boolean(connected) && !readOnly && phase === 'draft' && draftVersion !== null,
    connected: Boolean(connected),
  };
}

export function mountDispatchWorkflow({ element, onCommand = () => {} } = {}) {
  if (!element) throw new Error('dispatch workflow element is required');
  element.innerHTML = `<section class="dispatch-workflow" aria-label="배차 실행"><div class="dispatch-workflow-toolbar"><div class="dispatch-workflow-phase"><span>배차 단계</span><strong data-dispatch-phase>배차 전</strong></div><div class="dispatch-workflow-actions"><div><button type="button" class="button subtle" data-dispatch-open>배송원 선택·배차</button><button type="button" class="button" data-dispatch-publish>전체 배차 전송</button></div><small>배송원 뷰어에 확정 배차를 반영합니다.</small></div></div><div data-dispatch-summary></div><dialog class="dispatch-workflow-dialog" data-dispatch-dialog aria-labelledby="dispatch-workflow-title"><div class="dispatch-workflow-dialog-panel"><header><div><span>배차 계산</span><h2 id="dispatch-workflow-title">배송원 선택</h2></div><button type="button" class="dispatch-workflow-close" data-dispatch-close aria-label="닫기">${referenceIcon('close')}</button></header><label class="dispatch-workflow-search">${referenceIcon('search')}<input type="search" data-dispatch-search placeholder="배송원 이름 또는 차량번호 검색" aria-label="배송원 검색"></label><div class="dispatch-workflow-selection-tools"><strong data-dispatch-selected>0명 선택</strong><div><button type="button" data-dispatch-all>검색 결과 전체 선택</button><button type="button" data-dispatch-clear>선택 해제</button></div></div><div class="dispatch-workflow-candidates" data-dispatch-candidates></div><div class="dispatch-workflow-preview" data-dispatch-preview></div><p class="dispatch-workflow-error" data-dispatch-error role="status" hidden></p><footer><p data-dispatch-help>배송원을 선택해 배차 계산안을 만듭니다.</p><button type="button" class="button" data-dispatch-calculate>배차 계산</button></footer></div></dialog></section>`;

  const query = selector => element.querySelector(selector);
  const phase = query('[data-dispatch-phase]');
  const open = query('[data-dispatch-open]');
  const publish = query('[data-dispatch-publish]');
  const summary = query('[data-dispatch-summary]');
  const dialog = query('[data-dispatch-dialog]');
  const close = query('[data-dispatch-close]');
  const search = query('[data-dispatch-search]');
  const selectedCount = query('[data-dispatch-selected]');
  const selectAll = query('[data-dispatch-all]');
  const clear = query('[data-dispatch-clear]');
  const candidateList = query('[data-dispatch-candidates]');
  const preview = query('[data-dispatch-preview]');
  const error = query('[data-dispatch-error]');
  const help = query('[data-dispatch-help]');
  const calculate = query('[data-dispatch-calculate]');
  let model = dispatchWorkflowModel(null, false);
  let selected = new Set();
  let filter = '';
  let identity = '';
  let requestToken = 0;
  let busy = '';
  let destroyed = false;
  let candidateRenderKey = '';

  function visibleCandidates() {
    const needle = filter.trim().toLocaleLowerCase('ko-KR');
    if (!needle) return model.candidates;
    return model.candidates.filter(candidate => [candidate.driver, candidate.plate, candidate.region]
      .some(value => String(value || '').toLocaleLowerCase('ko-KR').includes(needle)));
  }

  function renderCandidates() {
    const visible = visibleCandidates();
    const nextRenderKey = JSON.stringify([
      model.phase,
      model.readOnly,
      busy,
      filter,
      [...selected].sort(),
      visible.map(candidate => [candidate.id, candidate.driver, candidate.plate, candidate.region, Boolean(candidate.locked)]),
    ]);
    if (nextRenderKey === candidateRenderKey) return;
    candidateRenderKey = nextRenderKey;
    selectedCount.textContent = `${selected.size}명 선택`;
    candidateList.innerHTML = visible.length ? visible.map(candidate => {
      const checked = selected.has(candidate.id);
      const locked = candidate.locked || busy !== '' || model.phase === 'published';
      return `<label class="dispatch-workflow-candidate"><input type="checkbox" data-dispatch-candidate="${escapeHtml(candidate.id)}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''}><span><strong>${escapeHtml(candidate.driver || '배송원 미등록')}</strong><small>${escapeHtml([candidate.plate, candidate.region].filter(Boolean).join(' / ') || '차량 정보 미등록')}</small></span>${candidate.locked ? '<em>필수</em>' : ''}</label>`;
    }).join('') : '<p class="dispatch-workflow-empty">검색 결과가 없습니다.</p>';
    selectAll.disabled = model.readOnly || model.phase === 'published' || busy !== '' || !visible.some(candidate => !selected.has(candidate.id));
    clear.disabled = model.readOnly || model.phase === 'published' || busy !== '' || ![...selected].some(id => !model.candidates.find(candidate => candidate.id === id)?.locked);
  }

  function renderPreview() {
    if (!model.preview.length) {
      preview.innerHTML = '';
      summary.innerHTML = `<p class="dispatch-workflow-volume"><span>배차 대상</span><span>주문 ${amount(model.summary.orders)}</span><span>배송지 ${amount(model.summary.destinations)}</span><span>${amount(model.summary.boxes)}박스</span></p>`;
      return;
    }
    const totals = model.preview.reduce((result, row) => ({
      orders: Number.isFinite(result.orders) && Number.isFinite(row.orders) ? result.orders + row.orders : null,
      destinations: Number.isFinite(result.destinations) && Number.isFinite(row.destinations) ? result.destinations + row.destinations : null,
      boxes: Number.isFinite(result.boxes) && Number.isFinite(row.boxes) ? result.boxes + row.boxes : null,
    }), { orders: 0, destinations: 0, boxes: 0 });
    const previewLabel = model.phase === 'published' ? '확정 배차' : '배차 계산안';
    preview.innerHTML = `<section aria-label="${previewLabel}"><h3>${previewLabel}</h3>${previewTable(model.preview)}</section>`;
    summary.innerHTML = `<details class="dispatch-workflow-summary"><summary><strong>${previewLabel} ${model.preview.length}대</strong><span class="dispatch-workflow-summary-counts"><span>주문 ${amount(totals.orders)}</span><span>배송지 ${amount(totals.destinations)}</span><span>${amount(totals.boxes)}박스</span></span></summary>${previewTable(model.preview)}</details>`;
  }

  function renderControls() {
    phase.textContent = model.phaseLabel;
    open.disabled = !model.connected || model.readOnly || model.phase === 'published' || busy !== '' || !model.candidates.length;
    publish.disabled = !model.canPublish || busy !== '';
    publish.textContent = busy === 'publish' ? '전체 배차 전송 중…' : '전체 배차 전송';
    calculate.textContent = busy === 'calculate' ? '배차 계산 중…' : '배차 계산';
    calculate.disabled = !model.connected || model.readOnly || model.phase === 'published' || busy !== '' || !model.canCalculate || !selected.size;
    help.textContent = !model.connected
      ? '운영 서버 연결을 확인하고 있습니다.'
      : model.phase === 'published'
        ? '확정된 배차입니다'
        : !model.canCalculate
          ? '배차 계산 기준 확인 중'
          : '배송원을 선택해 배차 계산안을 만듭니다.';
    renderCandidates();
  }

  function showError(message) {
    error.hidden = !message;
    error.textContent = message || '';
  }

  function openDialog() {
    if (open.disabled) return;
    dialog.showModal();
    search.focus();
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
    else open.focus();
  }

  function handleDialogClick(event) {
    if (event.target === dialog) closeDialog();
  }

  function handleCandidateChange(event) {
    const checkbox = event.target.closest?.('[data-dispatch-candidate]');
    if (!checkbox || checkbox.disabled) return;
    if (checkbox.checked) selected.add(checkbox.dataset.dispatchCandidate);
    else selected.delete(checkbox.dataset.dispatchCandidate);
    showError('');
    renderControls();
  }

  function handleSearch(event) {
    filter = event.target.value;
    renderCandidates();
  }

  function handleSelectAll() {
    visibleCandidates().forEach(candidate => selected.add(candidate.id));
    showError('');
    renderControls();
  }

  function handleClear() {
    selected = new Set(model.candidates.filter(candidate => candidate.locked).map(candidate => candidate.id));
    showError('');
    renderControls();
  }

  async function runCommand(command, payload, failureMessage) {
    const token = ++requestToken;
    const requestDate = model.date;
    busy = command === 'calculate_dispatch' ? 'calculate' : 'publish';
    showError('');
    renderControls();
    try {
      await onCommand(command, payload);
    } catch {
      if (!destroyed && token === requestToken && requestDate === model.date) showError(failureMessage);
    } finally {
      if (!destroyed && token === requestToken && requestDate === model.date) {
        busy = '';
        renderControls();
      }
    }
  }

  function calculateDispatch() {
    if (calculate.disabled) return;
    runCommand('calculate_dispatch', { vehicleIds: [...selected] }, '배차 계산을 완료하지 못했습니다. 다시 시도해 주세요.');
  }

  function publishDispatch() {
    if (publish.disabled) return;
    runCommand('publish_dispatch', { draftVersion: model.draftVersion }, '전체 배차 전송을 완료하지 못했습니다. 다시 시도해 주세요.');
  }

  function handleCancel(event) {
    event.preventDefault();
    closeDialog();
  }

  function restoreFocus() { open.focus(); }

  open.addEventListener('click', openDialog);
  publish.addEventListener('click', publishDispatch);
  close.addEventListener('click', closeDialog);
  search.addEventListener('input', handleSearch);
  candidateList.addEventListener('change', handleCandidateChange);
  selectAll.addEventListener('click', handleSelectAll);
  clear.addEventListener('click', handleClear);
  calculate.addEventListener('click', calculateDispatch);
  dialog.addEventListener('click', handleDialogClick);
  dialog.addEventListener('cancel', handleCancel);
  dialog.addEventListener('close', restoreFocus);

  return {
    update(data, connected = true) {
      const next = dispatchWorkflowModel(data, connected);
      const nextIdentity = `${next.date}|${candidateKey(next.candidates)}`;
      if (nextIdentity !== identity) {
        identity = nextIdentity;
        requestToken += 1;
        busy = '';
        filter = '';
        search.value = '';
        selected = new Set([
          ...next.candidateIds,
          ...next.candidates.filter(candidate => candidate.locked).map(candidate => candidate.id),
        ]);
        showError('');
      }
      model = next;
      if ((model.readOnly || model.phase === 'published') && dialog.open) closeDialog();
      renderPreview();
      renderControls();
    },
    destroy() {
      destroyed = true;
      requestToken += 1;
      open.removeEventListener('click', openDialog);
      publish.removeEventListener('click', publishDispatch);
      close.removeEventListener('click', closeDialog);
      search.removeEventListener('input', handleSearch);
      candidateList.removeEventListener('change', handleCandidateChange);
      selectAll.removeEventListener('click', handleSelectAll);
      clear.removeEventListener('click', handleClear);
      calculate.removeEventListener('click', calculateDispatch);
      dialog.removeEventListener('click', handleDialogClick);
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', restoreFocus);
      if (dialog.open) dialog.close();
      element.innerHTML = '';
    },
  };
}
