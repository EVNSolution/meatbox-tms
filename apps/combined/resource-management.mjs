import { referenceIcon } from './reference-icons.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const sourceDeliveries = data => Array.isArray(data?.fleetDeliveries)
  ? data.fleetDeliveries
  : Array.isArray(data?.deliveries) ? data.deliveries : null;

const displayText = value => String(value ?? '').trim() || '미등록';

function boxTotal(deliveries) {
  if (!deliveries) return null;
  if (deliveries.some(delivery => !Number.isFinite(delivery.boxes) || delivery.boxes < 0)) return null;
  return deliveries.reduce((sum, delivery) => sum + delivery.boxes, 0);
}

function assignedSummary(deliveries) {
  return {
    destinationCount: deliveries ? deliveries.length : null,
    boxCount: boxTotal(deliveries),
  };
}

function progressSummary(deliveries) {
  if (deliveries === null) return { completed: assignedSummary(null), remaining: assignedSummary(null), held: assignedSummary(null) };
  const completed = deliveries.filter(delivery => delivery.status === 'done');
  const remaining = deliveries.filter(delivery => delivery.status !== 'done');
  const held = deliveries.filter(delivery => delivery.status === 'skipped');
  return {
    completed: assignedSummary(completed),
    remaining: assignedSummary(remaining),
    held: assignedSummary(held),
  };
}

export function resourceManagementModel(data, query = '') {
  const vehicles = Array.isArray(data?.fleetVehicles) ? data.fleetVehicles.filter(vehicle => vehicle?.id) : [];
  const deliveries = sourceDeliveries(data);
  const deliveriesByVehicle = new Map(vehicles.map(vehicle => [vehicle.id, []]));
  for (const delivery of deliveries || []) {
    if (deliveriesByVehicle.has(delivery.vehicleId)) deliveriesByVehicle.get(delivery.vehicleId).push(delivery);
  }
  const needle = String(query).trim().toLocaleLowerCase('ko-KR');
  const resources = vehicles.map(vehicle => {
    const assigned = deliveries === null ? null : deliveriesByVehicle.get(vehicle.id);
    return {
      id: vehicle.id,
      vehicle,
      deliveries: assigned,
      summary: assignedSummary(assigned),
      progress: progressSummary(assigned),
      searchText: [vehicle.id, vehicle.plate, vehicle.driver, vehicle.region, ...(assigned || []).flatMap(delivery => [delivery.id, delivery.name, delivery.address])]
        .map(value => String(value ?? '').toLocaleLowerCase('ko-KR')).join(' '),
    };
  });
  return {
    resources,
    visible: needle ? resources.filter(resource => resource.searchText.includes(needle)) : resources,
    summary: assignedSummary(deliveries),
  };
}

function formatCount(value, unit) {
  return value === null ? '미등록' : `${value.toLocaleString('ko-KR')}${unit}`;
}

function resourceList(resources, selectedVehicleId, kind) {
  if (!resources.length) return '<li class="resource-empty">조회할 자원이 없습니다.</li>';
  return resources.map(resource => {
    const vehicle = resource.vehicle;
    const title = kind === 'drivers' ? displayText(vehicle.driver) : displayText(vehicle.plate);
    const meta = kind === 'drivers'
      ? `${displayText(vehicle.plate)} 차량 배정`
      : `배송원 ${displayText(vehicle.driver)}`;
    return `<li><button type="button" class="resource-row" data-resource-select="${escapeHtml(vehicle.id)}" aria-pressed="${vehicle.id === selectedVehicleId}">
      <span class="resource-row-icon">${referenceIcon(kind === 'drivers' ? 'user' : 'truck')}</span>
      <span class="resource-row-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta)}</small></span>
      <span class="resource-row-count">${escapeHtml(formatCount(resource.summary.destinationCount, '곳'))}</span>
      ${referenceIcon('next')}
    </button></li>`;
  }).join('');
}

function assignmentList(resource) {
  if (resource.deliveries === null) return '<p class="resource-empty">배정 배송지 데이터가 연결되지 않았습니다.</p>';
  if (!resource.deliveries.length) return '<p class="resource-empty">배정된 배송지가 없습니다.</p>';
  return `<ul class="resource-assignment-list">${resource.deliveries.map(delivery => `
    <li><button type="button" data-resource-delivery="${escapeHtml(delivery.id)}">
      <span><strong>${escapeHtml(displayText(delivery.name))}</strong><small>ID ${escapeHtml(delivery.id)}, ${escapeHtml(displayText(delivery.address))}</small></span>
      <span>${escapeHtml(Number.isFinite(delivery.boxes) && delivery.boxes >= 0 ? `${delivery.boxes}박스` : '박스 미등록')}</span>
      ${referenceIcon('next')}
    </button></li>`).join('')}</ul>`;
}

function resourceDetail(resource, kind) {
  if (!resource) return '<div class="resource-empty resource-detail-empty"><strong>선택할 자원이 없습니다.</strong><p>검색 조건이나 연결 데이터를 확인해 주세요.</p></div>';
  const vehicle = resource.vehicle;
  const title = kind === 'drivers' ? displayText(vehicle.driver) : displayText(vehicle.plate);
  const eyebrow = kind === 'drivers' ? '차량별 배정 배송원' : '차량';
  const unknownFields = kind === 'drivers' ? `
    <div><dt>성향</dt><dd>미등록</dd></div>
    <div><dt>메인 권역</dt><dd>미등록</dd></div>` : `
    <div><dt>배정 권역</dt><dd>${escapeHtml(displayText(vehicle.region))}</dd></div>
    <div><dt>운영 상태</dt><dd>${escapeHtml(displayText(vehicle.status))}</dd></div>`;
  return `<div class="resource-detail-body">
    <p class="eyebrow">${eyebrow}</p>
    <div class="resource-detail-heading"><div><h3>${escapeHtml(title)}</h3><p>${kind === 'drivers' ? `${escapeHtml(displayText(vehicle.plate))} 차량 배정. 배송원 고유 ID 미등록` : `차량 ID ${escapeHtml(vehicle.id)}`}</p></div><span class="resource-detail-icon">${referenceIcon(kind === 'drivers' ? 'user' : 'truck')}</span></div>
    <dl class="resource-facts">
      <div><dt>배정 배송지</dt><dd>${escapeHtml(formatCount(resource.summary.destinationCount, '곳'))}</dd></div>
      <div><dt>배정 박스</dt><dd>${escapeHtml(formatCount(resource.summary.boxCount, '박스'))}</dd></div>
      ${unknownFields}
    </dl>
    <section class="resource-progress" aria-label="당일 배송 지표">
      <h4>당일 배송 지표</h4>
      <dl>
        <div><dt>완료</dt><dd><strong>${escapeHtml(formatCount(resource.progress.completed.destinationCount, '곳'))}</strong><span>${escapeHtml(formatCount(resource.progress.completed.boxCount, '박스'))}</span></dd></div>
        <div><dt>잔여</dt><dd><strong>${escapeHtml(formatCount(resource.progress.remaining.destinationCount, '곳'))}</strong><span>${escapeHtml(formatCount(resource.progress.remaining.boxCount, '박스'))}</span></dd></div>
        <div><dt>보류</dt><dd><strong>${escapeHtml(formatCount(resource.progress.held.destinationCount, '곳'))}</strong><span>${escapeHtml(formatCount(resource.progress.held.boxCount, '박스'))}</span></dd></div>
      </dl>
      <p>보류 배송은 잔여에 포함됩니다.</p>
    </section>
    <button type="button" class="button primary resource-view-assignments" data-resource-assignments="${escapeHtml(vehicle.id)}">배정 배송지 조회</button>
    <section class="resource-assignments" aria-label="${escapeHtml(title)} 배정 배송지"><h4>연결된 배송지</h4>${assignmentList(resource)}</section>
  </div>`;
}

export function mountResourceManagement({ element, destinationElement, onSelectDelivery = () => {}, onSelectVehicle = () => {} }) {
  if (!element || !destinationElement) throw new TypeError('자원 관리와 배송지 영역이 필요합니다.');
  const destinationId = destinationElement.id || 'resource-destinations-panel';
  destinationElement.id = destinationId;
  element.innerHTML = `<section class="resource-management" aria-label="자원 관리">
    <div class="resource-tabs" role="tablist" aria-label="자원 종류">
      <button type="button" role="tab" id="resource-tab-drivers" aria-selected="false" aria-controls="resource-panel-drivers" tabindex="-1" data-resource-tab="drivers">${referenceIcon('user')}<span>배송원</span></button>
      <button type="button" role="tab" id="resource-tab-vehicles" aria-selected="false" aria-controls="resource-panel-vehicles" tabindex="-1" data-resource-tab="vehicles">${referenceIcon('truck')}<span>차량</span></button>
      <button type="button" role="tab" id="resource-tab-destinations" aria-selected="true" aria-controls="${escapeHtml(destinationId)}" data-resource-tab="destinations">${referenceIcon('location')}<span>배송지</span></button>
    </div>
    <section class="resource-panel" id="resource-panel-drivers" role="tabpanel" aria-labelledby="resource-tab-drivers" hidden>
      <div class="resource-panel-heading"><div><h2>배송원</h2><p>같은 이름도 배정 차량별로 구분합니다.</p></div><span data-resource-driver-count></span></div>
      <label class="resource-search"><span class="sr-only">배송원 검색</span>${referenceIcon('search')}<input type="search" data-resource-search="drivers" placeholder="배송원, 차량, 배송지 검색" autocomplete="off"></label>
      <div class="resource-split"><ul class="resource-list" data-resource-list="drivers"></ul><aside class="resource-detail" data-resource-detail="drivers"></aside></div>
    </section>
    <section class="resource-panel" id="resource-panel-vehicles" role="tabpanel" aria-labelledby="resource-tab-vehicles" hidden>
      <div class="resource-panel-heading"><div><h2>차량</h2><p>차량 ID 기준 배정 배송지와 박스를 조회합니다.</p></div><span data-resource-vehicle-count></span></div>
      <label class="resource-search"><span class="sr-only">차량 검색</span>${referenceIcon('search')}<input type="search" data-resource-search="vehicles" placeholder="차량, 배송원, 배송지 검색" autocomplete="off"></label>
      <div class="resource-split"><ul class="resource-list" data-resource-list="vehicles"></ul><aside class="resource-detail" data-resource-detail="vehicles"></aside></div>
    </section>
  </section>`;

  destinationElement.setAttribute('role', 'tabpanel');
  destinationElement.setAttribute('aria-labelledby', 'resource-tab-destinations');

  const tabs = [...element.querySelectorAll('[data-resource-tab]')];
  const panels = {
    drivers: element.querySelector('#resource-panel-drivers'),
    vehicles: element.querySelector('#resource-panel-vehicles'),
    destinations: destinationElement,
  };
  const lists = {
    drivers: element.querySelector('[data-resource-list="drivers"]'),
    vehicles: element.querySelector('[data-resource-list="vehicles"]'),
  };
  const details = {
    drivers: element.querySelector('[data-resource-detail="drivers"]'),
    vehicles: element.querySelector('[data-resource-detail="vehicles"]'),
  };
  const counts = {
    drivers: element.querySelector('[data-resource-driver-count]'),
    vehicles: element.querySelector('[data-resource-vehicle-count]'),
  };
  let activeTab = 'destinations';
  let data = null;
  let selectedVehicleId = null;
  let lastDeliveryId = null;
  const queries = { drivers: '', vehicles: '' };

  function selectTab(tab, focus = false) {
    activeTab = panels[tab] ? tab : 'destinations';
    for (const button of tabs) {
      const selected = button.dataset.resourceTab === activeTab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== activeTab;
    if (activeTab !== 'destinations') renderResources(activeTab);
  }

  function renderResources(kind) {
    const model = resourceManagementModel(data, queries[kind]);
    if (!model.resources.some(resource => resource.id === selectedVehicleId)) selectedVehicleId = model.resources[0]?.id || null;
    const selected = model.resources.find(resource => resource.id === selectedVehicleId) || null;
    const listMarkup = resourceList(model.visible, selectedVehicleId, kind);
    const detailMarkup = resourceDetail(selected, kind);
    if (lists[kind].innerHTML !== listMarkup) lists[kind].innerHTML = listMarkup;
    if (details[kind].innerHTML !== detailMarkup) details[kind].innerHTML = detailMarkup;
    const unit = kind === 'vehicles' ? '대' : '건 배정';
    counts[kind].textContent = `${model.visible.length.toLocaleString('ko-KR')} / ${model.resources.length.toLocaleString('ko-KR')}${unit}`;
  }

  function handleClick(event) {
    const tab = event.target.closest?.('[data-resource-tab]');
    if (tab) return selectTab(tab.dataset.resourceTab, true);
    const selected = event.target.closest?.('[data-resource-select]');
    if (selected) {
      selectedVehicleId = selected.dataset.resourceSelect;
      onSelectVehicle(selectedVehicleId);
      renderResources(activeTab);
      return;
    }
    const assignments = event.target.closest?.('[data-resource-assignments]');
    if (assignments) {
      onSelectVehicle(assignments.dataset.resourceAssignments);
      selectTab('destinations', true);
      return;
    }
    const delivery = event.target.closest?.('[data-resource-delivery]');
    if (delivery) {
      onSelectDelivery(delivery.dataset.resourceDelivery);
      selectTab('destinations', true);
    }
  }

  function handleInput(event) {
    const kind = event.target.dataset.resourceSearch;
    if (!['drivers', 'vehicles'].includes(kind)) return;
    queries[kind] = event.target.value;
    renderResources(kind);
  }

  function handleKeydown(event) {
    const tab = event.target.closest?.('[data-resource-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
    selectTab(next.dataset.resourceTab, true);
  }

  element.addEventListener('click', handleClick);
  element.addEventListener('input', handleInput);
  element.addEventListener('keydown', handleKeydown);

  return {
    update(nextData, selectedDeliveryId) {
      data = nextData;
      const deliveries = sourceDeliveries(data) || [];
      if (selectedDeliveryId && selectedDeliveryId !== lastDeliveryId) {
        selectedVehicleId = deliveries.find(delivery => delivery.id === selectedDeliveryId)?.vehicleId || selectedVehicleId;
      }
      lastDeliveryId = selectedDeliveryId;
      if (activeTab !== 'destinations') renderResources(activeTab);
    },
    destroy() {
      element.removeEventListener('click', handleClick);
      element.removeEventListener('input', handleInput);
      element.removeEventListener('keydown', handleKeydown);
      destinationElement.hidden = false;
    },
  };
}
