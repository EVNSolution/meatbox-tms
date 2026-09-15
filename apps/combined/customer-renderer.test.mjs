import test from 'node:test';
import assert from 'node:assert/strict';
import { customerEtaText, customerMapView, customerNoticeBody, customerPopupState, customerViewerDeliveries, nextCustomerPopup } from './customer-renderer.mjs';

test('고객에게는 정확 ETA 대신 30분 범위만 표시한다', () => {
  const delivery = { customerWindowText: '08:00~09:00', preciseTimeText: '08:30', status: 'current' };
  assert.equal(customerEtaText(delivery), '08:00~09:00');
  assert.equal(customerNoticeBody({ kind: 'departure', body: '08:30 도착 예정입니다.' }, delivery), '08:00~09:00 도착 예정입니다.');
  assert.equal(customerEtaText({ status: 'done', completedAt: '08:42' }), '08:42 배송 완료');
  assert.equal(customerEtaText({ status: 'pending' }), '시간 정보 미제공');
});

test('운영 계획은 도착 예정으로 표시하고 실제 완료 시각은 바꾸지 않는다', () => {
  const delivery = { etaSource: 'operating-plan', customerWindowText: '08:00 ~ 09:00', status: 'pending' };
  assert.equal(customerEtaText(delivery), '08:00 ~ 09:00 도착 예정');
  assert.equal(customerEtaText({ ...delivery, status: 'done', completedAt: '08:24' }), '08:24 배송 완료');
  assert.equal(customerEtaText({ ...delivery, status: 'current', arrivedAt: '08:18' }), '08:18 도착');
  assert.equal(customerEtaText({ ...delivery, status: 'skipped' }), '배송이 보류되었습니다');
});

test('배차 전과 계산안은 고객 주문만 남기고 기사·차량·ETA를 공개하지 않는다', () => {
  const order = {
    id: 'O1', name: '고객 매장', address: '서울', boxes: 3, coordinates: [127.1, 37.5], vehicleId: 'draft-vehicle', driver: '계산 기사',
    status: 'done', completedAt: '08:30', preciseTimeText: '08:10', customerWindowText: '07:40 ~ 08:40',
    notices: [{ id: 'notice', body: '주문 안내' }], timeline: [{ label: '배송 완료', time: '08:30' }],
  };
  for (const phase of ['unplanned', 'draft']) {
    const source = { sourceData: { date: '2026-09-16' }, dispatch: { phase }, dispatchOrders: [order], fleetDeliveries: [] };
    const before = structuredClone(source);
    const [visible] = customerViewerDeliveries(source);
    assert.equal(visible.id, 'O1');
    assert.equal(visible.status, 'pending');
    assert.equal(visible.customerStatus.label, '배차 대기');
    assert.equal(visible.dispatchPending, true);
    assert.equal(visible.vehicleId, undefined);
    assert.equal(visible.driver, undefined);
    assert.equal(visible.preciseTimeText, undefined);
    assert.equal(visible.customerWindowText, undefined);
    assert.equal(visible.completedAt, undefined);
    assert.deepEqual(visible.notices, order.notices);
    assert.equal(customerEtaText(visible), '배차 확정 대기');
    assert.deepEqual(customerMapView(visible, source, {}), { home: [127.1, 37.5], road: [], truck: null });
    assert.deepEqual(source, before);
  }
});

test('배차 확정 뒤에는 확정 주문만 고객 화면에 사용한다', () => {
  const confirmed = { id: 'C1', vehicleId: 'V1', status: 'pending' };
  const state = { sourceData: { date: '2026-09-16' }, dispatch: { phase: 'published' }, dispatchOrders: [{ id: 'D1' }], fleetDeliveries: [confirmed] };
  assert.deepEqual(customerViewerDeliveries(state), [confirmed]);
});

test('실데이터 고객 지도는 주문 좌표와 데모 차량 위치만 쓰고 기존 S1 도로를 섞지 않는다', () => {
  const delivery = { id: 'ord-real', vehicleId: 'real-a', status: 'current', coordinates: [127.12, 37.44] };
  const state = {
    sourceData: { date: '2025-09-12' },
    fleetVehicles: [{ id: 'real-a', location: { source: 'demo', coordinates: [127.1, 37.5] } }],
    vehicleStates: { 'real-a': { truck: { locationSource: 'demo', lng: 127.11, lat: 37.51 } } },
  };
  assert.deepEqual(customerMapView(delivery, state, { points: [{ id: 'S1', lng: 1, lat: 2 }], legs: {} }), {
    home: [127.12, 37.44], road: [], truck: [127.11, 37.51],
  });
  assert.deepEqual(customerMapView({ ...delivery, status: 'done' }, state, {}), {
    home: [127.12, 37.44], road: [], truck: null,
  });
});

test('운영자가 작성한 고객 안내는 ETA 시각과 같아도 원문을 유지한다', () => {
  const delivery = { customerWindowText: '06:38 ~ 07:38', preciseTimeText: '07:08' };
  const notice = { kind: 'manual', body: '매장 출입 가능 시간은 07:08입니다.' };
  assert.equal(customerNoticeBody(notice, delivery), notice.body);
});

test('이미 안내한 시간대와 실제 완료 시각은 현재 ETA로 다시 쓰지 않는다', () => {
  const delivery = { customerWindowText: '06:00 ~ 07:00', preciseTimeText: '06:30' };
  for (const notice of [
    { kind: 'departure', body: '도착 예정 시간은 06:30 ~ 07:30입니다.' },
    { kind: 'delay', body: '새 도착 예정 시간은 05:30 ~ 06:30입니다.' },
    { kind: 'completed', body: '06:30 상품 전달을 완료했습니다.' },
    { kind: 'complete', body: '06:30 문 앞에 상품을 전달했습니다.' },
    { kind: 'arrival', body: '06:30 기사님이 도착했습니다.' },
  ]) assert.equal(customerNoticeBody(notice, delivery), notice.body);
});

test('초기 이력은 팝업으로 열지 않고 새 알림만 한 번 선택한다', () => {
  const previous = new Set(['old']);
  assert.equal(nextCustomerPopup(previous, [{ id: 'old' }]), null);
  assert.equal(nextCustomerPopup(previous, [{ id: 'old' }, { id: 'new', title: '안내' }]).id, 'new');
});

test('팝업 기준 ID는 서버가 유지하는 현재 알림 이력 크기로 제한한다', () => {
  const previous = new Set(['pruned', 'kept']);
  const state = customerPopupState(previous, [{ id: 'kept' }, { id: 'new' }]);
  assert.equal(state.popup.id, 'new');
  assert.deepEqual([...state.currentIds], ['kept', 'new']);
  const next = customerPopupState(state.currentIds, [{ id: 'new' }]);
  assert.equal(next.popup, null);
  assert.deepEqual([...next.currentIds], ['new']);
});

test('한 번의 상태 전환에서 여러 알림이 들어오면 마지막 상태 알림을 팝업으로 표시한다', () => {
  const previous = new Set([1]);
  const notices = [{ id: 1, kind: 'ready' }, { id: 2, kind: 'delay' }, { id: 3, kind: 'shipping' }];
  assert.equal(nextCustomerPopup(previous, notices).id, 3);
  assert.equal(nextCustomerPopup(new Set([1, 2, 3]), [...notices, { id: 4, kind: 'shipping' }]).id, 4);
});

test('수정안 작성 중에도 고객은 기존 확정 배차와 차량 위치를 본다', () => {
  const confirmed = { id: 'O1', vehicleId: 'G1', status: 'current', coordinates: [127.1, 37.5] };
  const state = {
    sourceData: { date: '2026-09-16' }, dispatch: { phase: 'amending' },
    dispatchOrders: [{ ...confirmed, vehicleId: 'G2' }], fleetDeliveries: [confirmed],
    fleetVehicles: [{ id: 'G1', location: { source: 'demo', coordinates: [127.11, 37.51] } }],
  };
  assert.deepEqual(customerViewerDeliveries(state), [confirmed]);
  assert.deepEqual(customerMapView(confirmed, state, {}).truck, [127.11, 37.51]);
});
