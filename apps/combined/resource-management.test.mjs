import test from 'node:test';
import assert from 'node:assert/strict';
import { mountResourceManagement, resourceManagementModel } from './resource-management.mjs';

const vehicles = [
  { id: 'V1', plate: '서울 1', driver: '김기사', region: '송파·강남', status: 'running' },
  { id: 'V2', plate: '서울 2', driver: '김기사', region: '', status: '' },
];
const deliveries = [
  { id: 'S1', vehicleId: 'V1', name: '가락점', address: '송파구', boxes: 8, status: 'done' },
  { id: 'S2', vehicleId: 'V1', name: '문정점', address: '송파구', boxes: 0, status: 'skipped' },
  { id: 'S3', vehicleId: 'V2', name: '역삼점', address: '강남구', boxes: null, status: 'pending' },
];

test('배송원 이름이 같아도 차량 ID별 자원으로 유지하고 실제 배정만 집계한다', () => {
  const model = resourceManagementModel({ fleetVehicles: vehicles, fleetDeliveries: deliveries });
  assert.equal(model.resources.length, 2);
  assert.deepEqual(model.resources.map(resource => resource.id), ['V1', 'V2']);
  assert.deepEqual(model.resources[0].summary, { destinationCount: 2, boxCount: 8 });
  assert.deepEqual(model.resources[1].summary, { destinationCount: 1, boxCount: null });
  assert.deepEqual(model.summary, { destinationCount: 3, boxCount: null });
  assert.deepEqual(model.resources[0].progress, {
    completed: { destinationCount: 1, boxCount: 8 },
    remaining: { destinationCount: 1, boxCount: 0 },
    held: { destinationCount: 1, boxCount: 0 },
  });
  assert.deepEqual(model.resources[1].progress, {
    completed: { destinationCount: 0, boxCount: 0 },
    remaining: { destinationCount: 1, boxCount: null },
    held: { destinationCount: 0, boxCount: 0 },
  });
});

test('확인된 빈 배정은 0이고 배송지 또는 박스 데이터 누락은 미등록으로 남긴다', () => {
  const empty = resourceManagementModel({ fleetVehicles: vehicles, fleetDeliveries: [] });
  assert.deepEqual(empty.resources[0].summary, { destinationCount: 0, boxCount: 0 });
  assert.deepEqual(empty.resources[0].progress.remaining, { destinationCount: 0, boxCount: 0 });
  const missing = resourceManagementModel({ fleetVehicles: vehicles });
  assert.deepEqual(missing.resources[0].summary, { destinationCount: null, boxCount: null });
  assert.deepEqual(missing.resources[0].progress.completed, { destinationCount: null, boxCount: null });
  assert.deepEqual(missing.resources[0].progress.remaining, { destinationCount: null, boxCount: null });
  assert.deepEqual(missing.resources[0].progress.held, { destinationCount: null, boxCount: null });
  assert.deepEqual(missing.summary, { destinationCount: null, boxCount: null });
});

test('보류는 잔여에 포함하고 범주 안 박스 하나라도 없으면 부분 합계를 표시하지 않는다', () => {
  const model = resourceManagementModel({
    fleetVehicles: vehicles,
    fleetDeliveries: [
      { id: 'done', vehicleId: 'V1', status: 'done', boxes: 3 },
      { id: 'current', vehicleId: 'V1', status: 'current', boxes: 5 },
      { id: 'held', vehicleId: 'V1', status: 'skipped', boxes: null },
      { id: 'same-name-foreign', vehicleId: 'V2', status: 'done', boxes: 100 },
    ],
  });
  assert.deepEqual(model.resources[0].progress, {
    completed: { destinationCount: 1, boxCount: 3 },
    remaining: { destinationCount: 2, boxCount: null },
    held: { destinationCount: 1, boxCount: null },
  });
  assert.deepEqual(model.resources[1].progress.completed, { destinationCount: 1, boxCount: 100 });
});

test('차량·배송원·배정 배송지의 실제 값으로 검색한다', () => {
  const data = { fleetVehicles: vehicles, fleetDeliveries: deliveries };
  assert.deepEqual(resourceManagementModel(data, '서울 2').visible.map(item => item.id), ['V2']);
  assert.deepEqual(resourceManagementModel(data, '가락점').visible.map(item => item.id), ['V1']);
  assert.deepEqual(resourceManagementModel(data, '김기사').visible.map(item => item.id), ['V1', 'V2']);
});

test('운영 날짜와 배송 권역을 표시용 모델에 보존한다', () => {
  const model = resourceManagementModel({
    sourceData: { date: '2026-09-16', defaultVehicleId: 'V2' },
    fleetVehicles: vehicles,
    fleetDeliveries: [
      { ...deliveries[0], regionName: '서울 송파구', orderNumber: 'PAY-101' },
      { ...deliveries[1], regionName: '서울 송파구' },
      { ...deliveries[2], regionName: '서울 강남구' },
    ],
  }, 'PAY-101');
  assert.deepEqual(model.visible.map(item => item.id), ['V1']);
  assert.equal(model.resources[0].sourceDate, '2026-09-16');
  assert.equal(model.resources[0].sourceMode, true);
  assert.deepEqual(model.resources[0].originRegions, ['서울 송파구']);
});

class FakeNode {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.id = '';
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.tabIndex = 0;
    this.focused = false;
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener(type) { delete this.listeners[type]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focused = true; }
}

function fixture() {
  const element = new FakeNode();
  const destinationElement = new FakeNode();
  destinationElement.id = 'existing-destinations';
  const tabs = ['drivers', 'vehicles', 'destinations'].map(name => {
    const node = new FakeNode();
    node.dataset.resourceTab = name;
    node.closest = selector => selector === '[data-resource-tab]' ? node : null;
    return node;
  });
  const nodes = {
    '#resource-panel-drivers': new FakeNode(),
    '#resource-panel-vehicles': new FakeNode(),
    '[data-resource-list="drivers"]': new FakeNode(),
    '[data-resource-list="vehicles"]': new FakeNode(),
    '[data-resource-detail="drivers"]': new FakeNode(),
    '[data-resource-detail="vehicles"]': new FakeNode(),
    '[data-resource-driver-count]': new FakeNode(),
    '[data-resource-vehicle-count]': new FakeNode(),
    '[data-resource-search="drivers"]': new FakeNode(),
    '[data-resource-search="vehicles"]': new FakeNode(),
  };
  nodes['[data-resource-search="drivers"]'].dataset.resourceSearch = 'drivers';
  nodes['[data-resource-search="vehicles"]'].dataset.resourceSearch = 'vehicles';
  element.querySelectorAll = selector => selector === '[data-resource-tab]' ? tabs : [];
  element.querySelector = selector => nodes[selector];
  return { element, destinationElement, tabs, nodes };
}

const clickTarget = (attribute, value) => ({
  closest(selector) {
    if (selector !== `[${attribute}]`) return null;
    const datasetName = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return { dataset: { [datasetName]: value } };
  },
});

test('당일 주문 선택은 내부 ID 콜백만 보내고 누적 대장으로 전환하지 않는다', () => {
  const { element, destinationElement, tabs, nodes } = fixture();
  const selectedVehicles = [];
  const selectedDeliveries = [];
  const resources = mountResourceManagement({
    element,
    destinationElement,
    onSelectVehicle: id => selectedVehicles.push(id),
    onSelectDelivery: id => selectedDeliveries.push(id),
  });
  resources.update({ fleetVehicles: vehicles, fleetDeliveries: deliveries }, 'S1');
  assert.equal(destinationElement.hidden, false);
  assert.equal(destinationElement.attributes.role, 'tabpanel');

  element.listeners.click({ target: clickTarget('data-resource-tab', 'drivers') });
  assert.equal(destinationElement.hidden, true);
  assert.match(nodes['[data-resource-list="drivers"]'].innerHTML, /김기사/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /성향<\/dt><dd>미등록/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /메인 권역<\/dt><dd>미등록/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /당일 배송 지표/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /완료<\/dt><dd><strong>1곳<\/strong><span>8박스/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /잔여<\/dt><dd><strong>1곳<\/strong><span>0박스/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /보류<\/dt><dd><strong>1곳<\/strong><span>0박스/);
  const visible = nodes['[data-resource-detail="drivers"]'].innerHTML.replace(/<[^>]+>/g, '');
  assert.doesNotMatch(visible, /ID|S1|S2|V1/);
  assert.match(visible, /가락점송파구/);
  assert.match(visible, /당일 배정 배송지/);

  element.listeners.click({ target: clickTarget('data-resource-select', 'V2') });
  assert.deepEqual(selectedVehicles, ['V2']);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /서울 2 차량 배정/);

  element.listeners.click({ target: clickTarget('data-resource-delivery', 'S3') });
  assert.deepEqual(selectedDeliveries, ['S3']);
  assert.equal(destinationElement.hidden, true);
  assert.equal(tabs[0].attributes['aria-selected'], 'true');

  let prevented = false;
  element.listeners.keydown({ target: tabs[2], key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(tabs[0].focused, true);
  resources.destroy();
});

test('기본 차량과 운영 기준일을 자원 상세 기본값으로 쓴다', () => {
  const { element, destinationElement, nodes } = fixture();
  const resources = mountResourceManagement({ element, destinationElement });
  resources.update({
    sourceData: { date: '2026-09-16', defaultVehicleId: 'V2' },
    fleetVehicles: [{ ...vehicles[0], location: { label: '경기 성남 예시 위치' } }, { ...vehicles[1], location: { label: '서울 강남 예시 위치' } }],
    fleetDeliveries: deliveries.map(delivery => ({ ...delivery, regionName: delivery.vehicleId === 'V2' ? '서울 강남구' : '서울 송파구' })),
  }, null);
  element.listeners.click({ target: clickTarget('data-resource-tab', 'drivers') });
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /서울 2 차량 배정/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /2026-09-16 배송 지표/);
  assert.match(nodes['[data-resource-detail="drivers"]'].innerHTML, /배송 권역<\/dt><dd>서울 강남구/);
  assert.doesNotMatch(nodes['[data-resource-detail="drivers"]'].innerHTML, /원본|로컬|시연|데모|예시/);
  element.listeners.click({ target: clickTarget('data-resource-tab', 'vehicles') });
  assert.match(nodes['[data-resource-detail="vehicles"]'].innerHTML, /운영 상태<\/dt><dd>배차 운영/);
  assert.match(nodes['[data-resource-detail="vehicles"]'].innerHTML, /차량 위치<\/dt><dd>서울 강남 위치/);
  assert.doesNotMatch(nodes['[data-resource-detail="vehicles"]'].innerHTML, /원본|로컬|시연|데모|예시/);
  resources.destroy();
});

test('차량 선택은 당일 상세를 유지하며 배송지 대장과 혼합하지 않는다', () => {
  const { element, destinationElement, nodes } = fixture();
  const selectedVehicles = [];
  const resources = mountResourceManagement({ element, destinationElement, onSelectVehicle: id => selectedVehicles.push(id) });
  resources.update({ fleetVehicles: vehicles, fleetDeliveries: deliveries }, 'S1');
  element.listeners.click({ target: clickTarget('data-resource-tab', 'vehicles') });
  element.listeners.click({ target: clickTarget('data-resource-select', 'V1') });
  assert.deepEqual(selectedVehicles, ['V1']);
  assert.equal(destinationElement.hidden, true);
  assert.doesNotMatch(nodes['[data-resource-detail="vehicles"]'].innerHTML.replace(/<[^>]+>/g, ''), /ID|S1|V1/);
  resources.destroy();
});

test('같은 배송지 주문은 한 곳으로 집계하고 하위 주문의 권역과 결제번호도 검색한다', () => {
  const model = resourceManagementModel({ sourceData: { date: '2026-09-16' }, fleetVehicles: vehicles,
    fleetDeliveries: [
      { id: 'A', vehicleId: 'V1', name: '같은 매장', address: '같은 주소', regionName: '권역 1', orderNumber: '111', boxes: 2, status: 'done' },
      { id: 'B', vehicleId: 'V1', name: '같은 매장', address: '같은 주소', regionName: '권역 2', orderNumber: '222', boxes: 3, status: 'done' },
    ] }, '222');
  assert.equal(model.visible.length, 1);
  assert.deepEqual(model.resources[0].summary, { destinationCount: 1, boxCount: 5 });
  assert.deepEqual(model.resources[0].progress.completed, { destinationCount: 1, boxCount: 5 });
  assert.deepEqual(model.resources[0].originRegions, ['권역 1', '권역 2']);
});
