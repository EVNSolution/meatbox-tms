'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { OperatingSimulation, MAX_NOTICES, MAX_NOTICES_PER_STOP } = require('../lib/operating-simulation');
const { createDemo, validCommand } = require('../server');

const MIN = 60 * 1000;

function simulation() {
  let latest;
  const sim = new OperatingSimulation(state => { latest = state; });
  clearInterval(sim.timer);
  return { sim, latest: () => latest };
}

function shiftedEtas(sim, baseline, minutes) {
  sim.stopEtas = () => Object.fromEntries(sim.order.map(id => [id, baseline[id] + minutes * MIN]));
}

test('운영 초기 상태는 주문 접수 완료 60박스와 130대 임시 fleet을 제공한다', () => {
  const { sim, latest } = simulation();
  const state = latest();
  assert.equal(state.phase, 'idle');
  assert.equal(state.simClock, '05:45');
  assert.equal(state.order.every(stop => state.customers[stop.id].ordered), true);
  assert.deepEqual(state.order.map(stop => stop.boxes), [8, 7, 8, 6, 10, 7, 8, 6]);
  assert.equal(state.order.reduce((sum, stop) => sum + stop.boxes, 0), 60);
  assert.equal(state.kpi.boxesTotal, 60);
  assert.equal(state.fleet.vehicles.length, 130);
  assert.equal(state.fleet.vehicles[0].status, '출고 준비');
  assert.equal(state.fleet.deliveries.length, 387);
  assert.equal(state.fleet.vehicles.reduce((sum, vehicle) => sum + vehicle.capacityBoxes, 0), 7_800);
  assert.deepEqual(state.fleet.deliveries.slice(0, 3).map(stop => stop.id), ['V2-S1', 'V2-S2', 'V2-S3']);
  assert.equal(state.fleet.deliveries.at(-1).id, 'V130-S3');
  assert.equal(state.fleet.deliveries.every(stop => stop.address === '위치 데이터 대기' && stop.eta === null), true);
  assert.equal(state.order.every(stop => stop.tip === null), true);
  assert.equal(state.fleet.deliveries.every(stop => stop.tip === null), true);
  for (const customer of Object.values(state.customers)) {
    assert.deepEqual(customer.timeline.slice(0, 2).map(item => item.time), ['05:45', '05:45']);
  }
});

test('배송 완료 뒤에도 모든 live 주문 접수와 결제 시각은 05:45로 유지된다', () => {
  const { sim, latest } = simulation();
  for (let step = 0; step < 4; step++) sim.advance();
  sim.arriveAtStop();
  sim.completeCurrentStop();
  const first = latest().customers.S1.timeline;
  assert.deepEqual(first.slice(0, 2).map(item => [item.label, item.time]), [
    ['주문 접수', '05:45'],
    ['결제 완료', '05:45'],
  ]);
  assert.ok(first.find(item => item.label === '배송 완료').time);
});

test('고객 ETA는 약속 기준 30분 초과만 한 번 알리고 새 기준을 설정한다', () => {
  for (const [delay, expected] of [[29, 0], [30, 0], [31, 1]]) {
    const { sim } = simulation();
    const baseline = Object.fromEntries([...sim.customerPromises].map(([id, promise]) => [id, promise.arrival]));
    shiftedEtas(sim, baseline, delay);
    sim.recalcEtas('경계값 검증', { forceNotify: true });
    assert.equal(sim.notifications.filter(item => item.stopId === 'S1' && item.kind === 'delay').length, expected, `${delay}분`);
  }

  const { sim } = simulation();
  const baseline = Object.fromEntries([...sim.customerPromises].map(([id, promise]) => [id, promise.arrival]));
  shiftedEtas(sim, baseline, 15);
  sim.recalcEtas('누적 15분');
  shiftedEtas(sim, baseline, 31);
  sim.recalcEtas('누적 31분');
  assert.equal(sim.notifications.filter(item => item.stopId === 'S1' && item.kind === 'delay').length, 1);
  const renewed = sim.customerPromises.get('S1').arrival;
  sim.recalcEtas('동일 값 반복');
  shiftedEtas(sim, baseline, 61);
  sim.recalcEtas('새 기준 +30분');
  assert.equal(sim.notifications.filter(item => item.stopId === 'S1' && item.kind === 'delay').length, 1);
  shiftedEtas(sim, baseline, 62);
  sim.recalcEtas('새 기준 +31분');
  assert.equal(sim.notifications.filter(item => item.stopId === 'S1' && item.kind === 'delay').length, 2);
  assert.ok(sim.customerPromises.get('S1').arrival > renewed);
});

test('조기 도착과 순서 변경도 같은 고객 약속 기준을 따른다', () => {
  const { sim } = simulation();
  const baseline = Object.fromEntries([...sim.customerPromises].map(([id, promise]) => [id, promise.arrival]));
  const originalPromise = sim.customerPromises.get('S1').arrival;
  shiftedEtas(sim, baseline, -20);
  sim.recalcEtas('조기 도착');
  assert.equal(sim.customerPromises.get('S1').arrival, originalPromise);
  assert.equal(sim.notifications.length, 0);

  shiftedEtas(sim, baseline, 31);
  sim.reorder('S3', 'up');
  assert.equal(sim.order[1], 'S3');
  assert.equal(sim.notifications.some(item => item.stopId === 'S3' && item.kind === 'delay'), true);
});

test('출발 안내는 고객 시간대를 쓰고 도착과 완료 알림은 유지한다', () => {
  const { sim } = simulation();
  for (let step = 0; step < 4; step++) sim.advance();
  const departure = sim.notifications.find(item => item.stopId === 'S1' && item.kind === 'departure');
  assert.match(departure.body, /\d{2}:\d{2} ~ \d{2}:\d{2}/);
  assert.doesNotMatch(departure.body, /도착 예정 \d{2}:\d{2}(?! ~)/);
  sim.arriveAtStop();
  assert.equal(sim.notifications.some(item => item.stopId === 'S1' && item.kind === 'arrival'), true);
  sim.completeCurrentStop();
  assert.equal(sim.notifications.some(item => item.stopId === 'S1' && item.kind === 'complete'), true);
});

test('운영 알림과 배송팁 명령은 알려진 정차지의 인쇄 가능한 일반 문자열만 허용한다', () => {
  assert.equal(validCommand({ type: 'inject_traffic' }), false);
  assert.equal(validCommand({ type: 'inject_dwell' }), false);
  assert.equal(validCommand({ type: 'send_customer_notice', stopId: 'S1', body: '도착 전 확인해 주세요.' }), true);
  assert.equal(validCommand({ type: 'set_delivery_tip', stopId: 'V130-S3', body: '예시 팁' }), true);
  for (const command of [
    { type: 'send_customer_notice', stopId: 'S9', body: '안내' },
    { type: 'send_customer_notice', stopId: 'V131-S1', body: '안내' },
    { type: 'send_customer_notice', stopId: 'S1', body: '' },
    { type: 'send_customer_notice', stopId: 'S1', body: '가'.repeat(301) },
    { type: 'send_customer_notice', stopId: 'S1', body: '<img src=x onerror=alert(1)>' },
    { type: 'send_customer_notice', stopId: 'S1', body: '제어\u0000문자' },
    { type: 'set_delivery_tip', stopId: 'V2-S1', body: '' },
    { type: 'set_delivery_tip', stopId: 'V2-S1', body: '가'.repeat(501) },
  ]) assert.equal(validCommand(command), false, JSON.stringify(command).slice(0, 80));
  assert.equal(validCommand({ type: 'send_customer_notice', stopId: 'S1', body: '첫 줄\r\n둘째 줄' }), true);
  assert.equal(validCommand({ type: 'send_customer_notice', stopId: 'S1', body: '  앞뒤 공백은 정리  ' }), true);

  const { sim } = simulation();
  assert.equal(sim.sendCustomerNotice('S1', '  첫 줄\r\n둘째 줄  ', '운영자'), true);
  assert.equal(sim.notifications.at(-1).body, '첫 줄\n둘째 줄');
  assert.equal(sim.setDeliveryTip('V2-S1', '  배송 팁  '), true);
  assert.equal(sim.snapshot().fleet.deliveries.find(stop => stop.id === 'V2-S1').tip.body, '배송 팁');
});

test('알림 이력은 정차지별 50건과 전체 1000건의 최신 항목만 보존한다', () => {
  const perStop = simulation().sim;
  for (let index = 1; index <= 70; index++) perStop.notifyStop('S1', '운영자 안내', `안내 ${index}`, false, { kind: 'manual' });
  assert.equal(perStop.notifications.length, MAX_NOTICES_PER_STOP);
  assert.equal(perStop.notifications[0].body, '안내 21');
  assert.equal(perStop.notifications.at(-1).body, '안내 70');

  const global = simulation().sim;
  const stopIds = [...global.order, ...global.fleet.deliveries.map(stop => stop.id)];
  for (let index = 1; index <= 1_100; index++) {
    global.notifyStop(stopIds[(index - 1) % stopIds.length], '운영자 안내', `전체 안내 ${index}`, false, { kind: 'manual' });
  }
  assert.equal(global.notifications.length, MAX_NOTICES);
  assert.equal(global.notifications[0].id, 101);
  assert.equal(global.notifications.at(-1).id, 1_100);
  assert.equal(global.notifications.at(-1).body, '전체 안내 1100');
  global.reset();
  assert.equal(global.notifications.length, 0);
  global.notifyStop('S1', '운영자 안내', '리셋 뒤 최신 안내', false, { kind: 'manual' });
  assert.equal(global.notifications[0].id, 1_101);
});

test('인증된 두 WebSocket은 synthetic 알림과 팁을 함께 받고 reset은 미작성 상태로 복원한다', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-fleet-'));
  const origin = 'http://127.0.0.1:32123';
  const demo = createDemo({ accessFile: path.join(directory, 'access.json'), origin });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await demo.close(); await fs.rm(directory, { recursive: true, force: true }); });

  async function session(username, displayName) {
    const invite = await demo.access.issueInvite();
    await demo.access.register({ username, password: 'fleet-test-password', invite, displayName });
    return (await demo.access.login({ username, password: 'fleet-test-password' })).token;
  }
  const [firstToken, secondToken] = await Promise.all([session('operator-one', '운영자 하나'), session('operator-two', '운영자 둘')]);
  const endpoint = `ws://127.0.0.1:${demo.server.address().port}/ws/simulation`;
  const connect = token => new WebSocket(endpoint, { headers: { origin, cookie: `meatbox_session=${token}` } });
  const first = connect(firstToken);
  const second = connect(secondToken);
  await Promise.all([once(first, 'message'), once(second, 'message')]);

  const nextState = (ws, predicate) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error('state timeout')); }, 2_000);
    function receive(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'state' && predicate(message.state)) {
        clearTimeout(timeout);
        ws.off('message', receive);
        resolve(message.state);
      }
    }
    ws.on('message', receive);
  });

  const noticeCommand = { type: 'send_customer_notice', stopId: 'V2-S1', body: '상차가 끝나면 다시 안내드리겠습니다.' };
  const noticeStates = [nextState(first, state => state.notifications.some(item => item.body === noticeCommand.body)), nextState(second, state => state.notifications.some(item => item.body === noticeCommand.body))];
  first.send(JSON.stringify(noticeCommand));
  const [firstNotice, secondNotice] = await Promise.all(noticeStates);
  for (const state of [firstNotice, secondNotice]) {
    const notice = state.notifications.find(item => item.body === noticeCommand.body);
    assert.equal(notice.stopId, 'V2-S1');
    assert.equal(notice.author, '운영자 하나');
    assert.equal(notice.channel, '고객 팝업');
    assert.equal(notice.status, '시연 발송');
    assert.equal(notice.clock, notice.time);
    assert.equal(state.notifications.some(item => item.stopId === 'S1' && item.body === noticeCommand.body), false);
  }
  const firstNoticeId = firstNotice.notifications.at(-1).id;

  const changedTip = '후문에서 예시 배송을 인계합니다.';
  const tipStates = [nextState(first, state => state.fleet.deliveries.find(stop => stop.id === 'V2-S1').tip?.body === changedTip), nextState(second, state => state.fleet.deliveries.find(stop => stop.id === 'V2-S1').tip?.body === changedTip)];
  second.send(JSON.stringify({ type: 'set_delivery_tip', stopId: 'V2-S1', body: changedTip }));
  const [, secondTip] = await Promise.all(tipStates);
  assert.equal(secondTip.fleet.deliveries.find(stop => stop.id === 'V2-S1').tip.author, '예시 배송원 002');

  const resets = [nextState(first, state => state.notifications.length === 0 && state.fleet.deliveries.find(stop => stop.id === 'V2-S1').tip === null), nextState(second, state => state.notifications.length === 0)];
  first.send(JSON.stringify({ type: 'reset' }));
  await Promise.all(resets);
  const afterReset = nextState(first, state => state.notifications.some(item => item.body === '리셋 이후 안내'));
  first.send(JSON.stringify({ type: 'send_customer_notice', stopId: 'S1', body: '리셋 이후 안내' }));
  assert.ok((await afterReset).notifications.at(-1).id > firstNoticeId);

  const denied = new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, { headers: { origin: 'https://attacker.invalid', cookie: `meatbox_session=${firstToken}` } });
    ws.once('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 401); response.resume(); ws.terminate(); resolve(); });
    ws.once('open', () => { ws.terminate(); reject(new Error('cross-origin websocket accepted')); });
    ws.on('error', () => {});
  });
  await denied;
  first.terminate();
  second.terminate();
});

test('같은 계정의 두 WebSocket은 초당 명령 10건 제한을 공유한다', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-rate-'));
  const origin = 'http://127.0.0.1:32123';
  const demo = createDemo({ accessFile: path.join(directory, 'access.json'), origin });
  await new Promise(resolve => demo.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await demo.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const invite = await demo.access.issueInvite();
  await demo.access.register({ username: 'shared-rate', password: 'fleet-test-password', invite });
  const { token } = await demo.access.login({ username: 'shared-rate', password: 'fleet-test-password' });
  const endpoint = `ws://127.0.0.1:${demo.server.address().port}/ws/simulation`;
  const connect = () => new WebSocket(endpoint, { headers: { origin, cookie: `meatbox_session=${token}` } });
  const first = connect();
  const second = connect();
  await Promise.all([once(first, 'message'), once(second, 'message')]);

  const startedAt = Date.now();
  for (let index = 0; index < 10; index++) {
    const state = once(first, 'message');
    (index % 2 ? second : first).send(JSON.stringify({ type: 'reset' }));
    await state;
  }
  assert.ok(Date.now() - startedAt < 1_000, 'rate-limit commands must stay in one window');
  const closed = once(second, 'close');
  second.send(JSON.stringify({ type: 'reset' }));
  assert.equal((await closed)[0], 4429);
  assert.equal(first.readyState, WebSocket.OPEN);
  first.terminate();
});
