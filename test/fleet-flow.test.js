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
  sim.setScenario('completed', 'S1');
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
  sim.setScenario('shipping', 'S1');
  const departure = sim.notifications.find(item => item.stopId === 'S1' && item.kind === 'shipping');
  assert.match(departure.body, /\d{2}:\d{2} ~ \d{2}:\d{2}/);
  assert.doesNotMatch(departure.body, /도착 예정 \d{2}:\d{2}(?! ~)/);
  sim.setScenario('arrived', 'S1');
  assert.equal(sim.notifications.some(item => item.stopId === 'S1' && item.kind === 'arrived'), true);
  sim.completeCurrentStop();
  assert.equal(sim.notifications.some(item => item.stopId === 'S1' && item.kind === 'completed'), true);
});

test('여섯 수동 preset은 선택한 S5를 고정 시각의 일관된 상태로 만든다', () => {
  const { sim, latest } = simulation();
  const expected = {
    received: ['idle', '05:45', 'pending', null],
    picking: ['preparing', '05:50', 'pending', null],
    ready: ['preparing', '06:20', 'pending', null],
    shipping: ['delivering', '07:10', 'current', 'S5'],
    arrived: ['delivering', '07:14', 'current', null],
    completed: ['delivering', '07:15', 'done', 'S6'],
  };
  for (const [scenario, [phase, clock, status, nextId]] of Object.entries(expected)) {
    assert.equal(sim.setScenario(scenario, 'S5'), true);
    const state = latest();
    const selected = state.order.find(stop => stop.id === 'S5');
    assert.equal(state.scenarioPreset, scenario);
    assert.equal(state.scenarioStopId, 'S5');
    assert.equal(state.customerStopId, 'S5');
    assert.equal(state.phase, phase);
    assert.equal(state.simClock, clock);
    assert.equal(selected.status, status);
    assert.equal(state.truck.toId, nextId);
    assert.equal(state.order.slice(0, 4).every(stop => ['shipping', 'arrived', 'completed'].includes(scenario) ? stop.status === 'done' : stop.status === 'pending'), true);
  }
});

test('도착과 완료 preset도 shipping에서 안내한 고객 시간대를 유지한다', () => {
  const { sim, latest } = simulation();
  sim.setScenario('shipping', 'S5');
  const shipping = latest().customers.S5.eta;
  assert.ok(shipping.windowText);
  assert.equal(shipping.preciseTimeText, '07:14');
  sim.setScenario('arrived', 'S5');
  assert.equal(latest().customers.S5.eta.windowText, shipping.windowText);
  assert.equal(latest().customers.S5.eta.preciseTimeText, '07:14');
  sim.setScenario('completed', 'S5');
  assert.equal(latest().customers.S5.eta.windowText, shipping.windowText);
  assert.equal(latest().customers.S5.eta.preciseTimeText, '07:14');
});

test('보류한 배송은 보존된 약속이 있어도 고객 ETA를 공개하지 않는다', async () => {
  const { sim } = simulation();
  assert.ok(sim.customerPromises.has('S1'));
  sim.toggleSkip('S1');
  const state = sim.snapshot();
  assert.equal(state.order.find(stop => stop.id === 'S1').status, 'skipped');
  assert.equal(state.customers.S1.status.key, 'held');
  assert.equal(state.customers.S1.eta, null);

  const { adaptSimulation, publishedEtaText } = await import('../apps/combined/simulation-adapter.mjs');
  const delivery = adaptSimulation(state).deliveries.find(stop => stop.id === 'S1');
  assert.equal(delivery.officialEta, null);
  assert.equal(delivery.customerWindowText, null);
  assert.equal(publishedEtaText(delivery), '미확인');
});

test('순서 변경 뒤 preset을 골라도 기존 고객 약속과 정확 ETA를 다시 초기화하지 않는다', () => {
  const { sim } = simulation();
  const promisedWindow = sim.snapshot().customers.S8.eta.windowText;
  sim.order = ['S8', ...sim.order.filter(id => id !== 'S8')];
  sim.recalcEtas('운영 배송 순서 변경');
  const reordered = sim.snapshot().customers.S8.eta;
  const delayCount = sim.notifications.filter(item => item.stopId === 'S8' && item.kind === 'delay').length;
  assert.equal(reordered.windowText, promisedWindow);
  sim.setScenario('shipping', 'S8');
  const shipping = sim.snapshot().customers.S8.eta;
  assert.equal(shipping.windowText, promisedWindow);
  assert.equal(shipping.preciseTimeText, reordered.preciseTimeText);
  assert.equal(sim.notifications.filter(item => item.stopId === 'S8' && item.kind === 'delay').length, delayCount);
});

test('수동 preset은 자동 진행하지 않고 같은 선택을 반복 전송하지 않는다', async () => {
  let broadcasts = 0;
  let latest;
  const sim = new OperatingSimulation(state => { broadcasts++; latest = state; });
  assert.equal(sim.timer, null);
  sim.setScenario('shipping', 'S5');
  const frozen = JSON.stringify(latest);
  const count = broadcasts;
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(JSON.stringify(latest), frozen);
  assert.equal(broadcasts, count);
  assert.equal(sim.setScenario('shipping', 'S5'), false);
  assert.equal(broadcasts, count);
  assert.equal(sim.notifications.filter(item => item.kind === 'shipping' && item.stopId === 'S5').length, 1);
});

test('preset 전환은 수동 안내와 배송팁을 보존하고 명시적 reset만 지운다', () => {
  const { sim, latest } = simulation();
  sim.sendCustomerNotice('S5', '운영자가 입력한 안내', '운영자');
  sim.setDeliveryTip('S5', '배송원이 입력한 팁');
  sim.setScenario('shipping', 'S5');
  sim.setScenario('arrived', 'S5');
  assert.equal(latest().notifications.some(item => item.kind === 'manual' && item.body === '운영자가 입력한 안내'), true);
  assert.equal(latest().order.find(stop => stop.id === 'S5').tip.body, '배송원이 입력한 팁');
  sim.reset();
  assert.equal(latest().notifications.length, 0);
  assert.equal(latest().order.find(stop => stop.id === 'S5').tip, null);
  assert.equal(latest().scenarioPreset, 'received');
  assert.equal(latest().scenarioStopId, 'S1');
});

test('운영 알림과 배송팁 명령은 알려진 정차지의 인쇄 가능한 일반 문자열만 허용한다', () => {
  assert.equal(validCommand({ type: 'inject_traffic' }), false);
  assert.equal(validCommand({ type: 'inject_dwell' }), false);
  assert.equal(validCommand({ type: 'advance' }), false);
  assert.equal(validCommand({ type: 'place_order' }), false);
  assert.equal(validCommand({ type: 'speed', value: 20 }), false);
  assert.equal(validCommand({ type: 'set_scenario', scenario: 'shipping', stopId: 'S5' }), true);
  assert.equal(validCommand({ type: 'set_scenario', scenario: 'unknown', stopId: 'S5' }), false);
  assert.equal(validCommand({ type: 'set_scenario', scenario: 'shipping', stopId: 'V2-S1' }), false);
  assert.equal(validCommand({ type: 'set_scenario', scenario: 'shipping', stopId: ['S1'] }), false);
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

test('시나리오를 다시 진행하면 각 상태 알림을 새 ID로 재생하고 같은 상태 연속 클릭만 무시한다', () => {
  const { sim } = simulation();
  const scenarios = ['received', 'picking', 'ready', 'shipping', 'arrived', 'completed'];
  const ids = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const scenario of scenarios) {
      assert.equal(sim.setScenario(scenario, 'S3'), true);
      const notices = sim.notifications.filter(notice => notice.stopId === 'S3' && notice.kind === scenario);
      assert.equal(notices.length, cycle + 1, `${scenario} 반복 실행도 새 알림 생성`);
      ids.push(notices.at(-1).id);
      const count = sim.notifications.length;
      assert.equal(sim.setScenario(scenario, 'S3'), false);
      assert.equal(sim.notifications.length, count, '변경 없는 연속 클릭은 중복 알림 없음');
    }
  }
  assert.equal(new Set(ids).size, 12);
});
