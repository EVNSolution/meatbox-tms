import test from 'node:test';
import assert from 'node:assert/strict';
import { pickupOrders, pickupPayload, pushResultText, createDriverMessageClient, mountDriverTools } from './driver-tools.ts';
import { seoulToday } from './operating-date.mjs';

const date = seoulToday();
const message = (id, from = 'driver', body = '도착했습니다.') => ({ id, from, body, createdAt: `${date}T01:30:00Z` });
const vehicle = { id: 'V1', plate: '12가3456', driver: '배송원' };
const orders = [{ id: 'order-a', vehicleId: 'V1', name: '매장', address: '서울', boxes: 2 }, { id: 'order-b', vehicleId: 'V1', name: '매장', address: '서울', boxes: 3 }];
const data = { sourceData: { date }, sourceOrders: orders, connected: true };
const row = { vehicle, deliveries: [{ ...orders[0], orders }] };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

class FakeNode {
  innerHTML = ''; textContent = ''; value = ''; open = false; disabled = false; hidden = false;
  scrollHeight = 100; scrollTop = 0; clientHeight = 100; listeners = {};
  addEventListener(type, callback) { this.listeners[type] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  focus() {}
}
function fixture(client, extra = {}) {
  const nodes = new Map();
  const element = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new FakeNode()); return nodes.get(selector); } };
  const api = mountDriverTools({ element, client, today: () => date, pollMs: 60000, ...extra });
  const node = selector => nodes.get(selector);
  api.update(data, row);
  return { api, node, click: selector => node(selector).listeners.click(), submit: () => node('[data-message-form]').listeners.submit({ preventDefault() {} }) };
}
globalThis.document = { body: { classList: { add() {}, remove() {} } } };

test('수령 QR은 묶음의 모든 개별 주문을 차량별로 선택하고 개인정보를 인코딩하지 않는다', () => {
  const another = { id: 'other', vehicleId: 'V2', name: '다른 매장' };
  assert.deepEqual(pickupOrders({ sourceOrders: [...orders, orders[0], another] }, row), orders);
  assert.deepEqual(pickupOrders({}, row), orders);
  assert.equal(pickupPayload(date, 'order-b'), `meatbox:${date}:order-b`);
  assert.throws(() => pickupPayload('2026-02-30', 'order-a'));
  assert.throws(() => pickupPayload(date, 'bad\norder'));
  assert.doesNotMatch(pickupPayload(date, 'order-a'), /서울|매장|3456|배송원/);
});

test('메시지 요청은 날짜·차량·동일 출처 인증을 유지하고 운영자 발신만 저장한다', async () => {
  const calls = [];
  const client = createDriverMessageClient(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => options.method === 'GET' ? { messages: [message('reply')] } : { message: message('new', 'ops', '안내'), push: { status: 'no-device', attempted: 0, sent: 0, failed: 0 } } };
  });
  assert.equal((await client.load(date, 'V1&other=bad'))[0].from, 'driver');
  assert.equal(calls[0].url, `/api/dispatch-data/days/${date}/driver/messages?vehicleId=V1%26other%3Dbad`);
  const result = await client.send(date, 'V1', ' 안내 ');
  assert.deepEqual(JSON.parse(calls[1].options.body), { vehicleId: 'V1', body: '안내', from: 'ops' });
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
  assert.equal(result.push.status, 'no-device');
  await assert.rejects(client.send('2000-01-01', 'V1', '메시지'), /과거/);
  await assert.rejects(client.send(date, 'V1', ' '.repeat(10)), /1~1000/);
  await assert.rejects(client.send(date, 'V1', 'a'.repeat(1001)), /1~1000/);
  assert.equal(calls.length, 2);
});

test('조회 응답과 저장 응답 오류를 성공으로 표시하지 않고 불확실한 전송은 기록 확인을 안내한다', async () => {
  const invalid = createDriverMessageClient(async () => ({ ok: true, json: async () => ({ messages: [{ ...message('bad'), from: 'admin' }] }) }));
  await assert.rejects(invalid.load(date, 'V1'), /응답 형식/);
  await assert.rejects(invalid.send(date, 'V1', '안내'), /저장 응답/);
  const failed = createDriverMessageClient(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(failed.send(date, 'V1', '안내'), /전송 결과.*기록/);
  const forbidden = createDriverMessageClient(async () => ({ ok: false, status: 403 }));
  await assert.rejects(forbidden.load(date, 'V1'), /권한/);
});

test('FCM 접수와 기기 수신을 구분하고 설정·기기 없음에서도 메시지 저장 여부를 분리한다', () => {
  assert.match(pushResultText({ status: 'sent' }), /FCM에 접수.*기기 수신 여부는 확인되지/);
  assert.match(pushResultText({ status: 'partial' }), /일부 기기/);
  assert.match(pushResultText({ status: 'unconfigured' }), /설정.*보내지/);
  assert.match(pushResultText({ status: 'no-device' }), /기기.*보내지/);
  assert.match(pushResultText({ status: 'failed' }), /실패.*저장/);
  assert.match(pushResultText({ status: 'other' }), /확인하지 못/);
});

test('QR 대화상자는 모든 주문을 렌더링하고 생성 완료 전에 인쇄하지 않는다', async t => {
  const pending = deferred(), seen = [];
  let prints = 0;
  const f = fixture({ load() {}, send() {} }, { qrCode: (payload, options) => { seen.push({ payload, options }); return pending.promise; }, print: () => { prints += 1; } });
  t.after(() => f.api.destroy());
  f.click('[data-driver-pickup]');
  assert.equal(f.node('[data-pickup-dialog]').open, true);
  assert.equal(f.node('[data-pickup-print]').disabled, true);
  f.click('[data-pickup-print]');
  assert.equal(prints, 0);
  pending.resolve('data:image/png;base64,AA=='); await flush();
  assert.deepEqual(seen.map(item => item.payload), orders.map(order => pickupPayload(date, order.id)));
  assert.equal(seen[0].options.margin, 4);
  assert.equal(f.node('[data-pickup-print]').disabled, false);
  assert.equal((f.node('[data-pickup-sheet]').innerHTML.match(/class="pickup-card"/g) ?? []).length, 2);
  f.click('[data-pickup-print]'); assert.equal(prints, 1);
});

test('같은 날짜·차량의 배정·순서·출력 정보가 바뀌면 기존 QR 인쇄를 무효화한다', async t => {
  const changes = [
    { name: '배정 해제', orders: orders.slice(1) },
    { name: '순서 변경', orders: [...orders].reverse() },
    { name: '배송지 이름', orders: [{ ...orders[0], name: '변경 매장' }, orders[1]] },
    { name: '주소', orders: [{ ...orders[0], address: '변경 주소' }, orders[1]] },
    { name: '박스 수', orders: [{ ...orders[0], boxes: 5 }, orders[1]] },
    { name: '차량번호', orders, vehicle: { ...vehicle, plate: '99나9999' } },
  ];
  for (const change of changes) {
    await t.test(change.name, async () => {
      let prints = 0;
      const f = fixture({ load() {}, send() {} }, { qrCode: async () => 'data:image/png;base64,AA==', print: () => { prints += 1; } });
      try {
        f.click('[data-driver-pickup]'); await flush();
        assert.equal(f.node('[data-pickup-print]').disabled, false);
        f.api.update({ ...data, sourceOrders: change.orders }, { ...row, vehicle: change.vehicle ?? vehicle });
        assert.equal(f.node('[data-pickup-dialog]').open, false);
        assert.equal(f.node('[data-pickup-print]').disabled, true);
        assert.equal(f.node('[data-pickup-sheet]').innerHTML, '');
        f.click('[data-pickup-print]'); assert.equal(prints, 0);
        f.click('[data-driver-pickup]'); await flush();
        assert.equal((f.node('[data-pickup-sheet]').innerHTML.match(/class="pickup-card"/g) ?? []).length, change.orders.length);
        assert.ok(f.node('[data-pickup-sheet]').innerHTML.indexOf(change.orders[0].id) < f.node('[data-pickup-sheet]').innerHTML.lastIndexOf(change.orders.at(-1).id));
      } finally { f.api.destroy(); }
    });
  }
});

test('배정 변경 전 시작한 QR 생성은 새 출력 화면을 덮지 않는다', async t => {
  const old = deferred(); let renders = 0;
  const f = fixture({ load() {}, send() {} }, { qrCode: async () => ++renders <= 2 ? old.promise : 'data:image/png;base64,NEW=' });
  t.after(() => f.api.destroy());
  f.click('[data-driver-pickup]');
  f.api.update({ ...data, sourceOrders: orders.slice(1) }, row);
  assert.equal(f.node('[data-pickup-dialog]').open, false);
  f.click('[data-driver-pickup]'); await flush();
  const latestSheet = f.node('[data-pickup-sheet]').innerHTML;
  assert.doesNotMatch(latestSheet, /order-a/);
  old.resolve('data:image/png;base64,OLD='); await flush();
  assert.equal(f.node('[data-pickup-sheet]').innerHTML, latestSheet);
  assert.match(f.node('[data-pickup-status]').textContent, /주문 1건/);
});

test('같은 조회 대상의 갱신은 QR 화면과 작성 중인 메시지를 불필요하게 닫지 않는다', async t => {
  const load = deferred();
  const f = fixture({ load: () => load.promise, send() {} }, { qrCode: async () => 'data:image/png;base64,AA==' });
  t.after(() => f.api.destroy());
  f.click('[data-driver-pickup]'); await flush();
  f.api.update({ ...data, sourceOrders: orders.map(order => ({ ...order, status: 'done' })) }, row);
  assert.equal(f.node('[data-pickup-dialog]').open, true);
  assert.equal(f.node('[data-pickup-print]').disabled, false);
  f.click('[data-pickup-close]');
  f.click('[data-driver-messages]'); f.node('[data-message-body]').value = '작성 중인 안내';
  f.api.update({ ...data, sourceOrders: orders.slice(1) }, row);
  assert.equal(f.node('[data-message-dialog]').open, true);
  assert.equal(f.node('[data-message-body]').value, '작성 중인 안내');
  load.resolve([message('reply')]); await flush();
  assert.match(f.node('[data-message-list]').innerHTML, /도착했습니다/);
});

test('늦게 도착한 다른 차량의 응답은 현재 메시지와 입력을 덮지 않는다', async t => {
  const old = deferred(); let loads = 0;
  const f = fixture({ load: () => ++loads === 1 ? old.promise : Promise.resolve([message('new', 'driver', '<img onerror=bad>')]), send() {} });
  t.after(() => f.api.destroy());
  f.click('[data-driver-messages]');
  f.node('[data-message-body]').value = '이전 차량 내용';
  f.api.update(data, { vehicle: { id: 'V2' }, deliveries: [] });
  assert.equal(f.node('[data-message-dialog]').open, false);
  assert.equal(f.node('[data-message-body]').value, '');
  f.click('[data-driver-messages]'); await flush();
  old.resolve([message('old', 'driver', '이전 차량 메시지')]); await flush();
  assert.doesNotMatch(f.node('[data-message-list]').innerHTML, /이전 차량 메시지|<img/);
  assert.match(f.node('[data-message-list]').innerHTML, /&lt;img onerror=bad&gt;/);
});

test('과거·읽기 전용·연결 끊김에서는 보내지 않고 배송원 회신 조회를 유지한다', async t => {
  let sends = 0;
  const f = fixture({ load: async () => [message('reply')], send: () => { sends += 1; } });
  t.after(() => f.api.destroy());
  for (const next of [{ ...data, sourceData: { date: '2000-01-01' } }, { ...data, dispatch: { readOnly: true } }, { ...data, connected: false }]) {
    f.api.update(next, row); f.click('[data-driver-messages]'); await flush();
    assert.equal(f.node('[data-message-send]').disabled, true);
    assert.match(f.node('[data-message-list]').innerHTML, /배송원.*도착했습니다/s);
    f.node('[data-message-body]').value = '전송 금지'; await f.submit();
    f.click('[data-message-close]');
  }
  assert.equal(sends, 0);
});

test('메시지 저장 뒤 기기가 없음을 표시하고 이전 조회가 새 메시지를 지우지 않는다', async t => {
  const load = deferred(), send = deferred();
  const f = fixture({ load: () => load.promise, send: () => send.promise });
  t.after(() => f.api.destroy());
  f.click('[data-driver-messages]');
  f.node('[data-message-body]').value = '안내';
  const submission = f.submit();
  assert.equal(f.node('[data-message-send]').disabled, true);
  send.resolve({ message: message('saved', 'ops', '안내'), push: { status: 'no-device' } }); await submission;
  load.resolve([]); await flush();
  assert.match(f.node('[data-message-send-status]').textContent, /저장되었습니다.*기기가 없어/);
  assert.match(f.node('[data-message-list]').innerHTML, /안내/);
  assert.equal(f.node('[data-message-body]').value, '');
  assert.equal(f.node('[data-message-send]').disabled, false);
});

test('전송 중 대화상자를 다시 열어도 중복 전송을 허용하지 않는다', async t => {
  const pending = deferred(); let sends = 0;
  const f = fixture({ load: async () => [], send: () => { sends += 1; return pending.promise; } });
  t.after(() => f.api.destroy());
  f.click('[data-driver-messages]'); await flush();
  f.node('[data-message-body]').value = '안내'; const submission = f.submit();
  f.click('[data-message-close]'); f.click('[data-driver-messages]');
  assert.equal(f.node('[data-message-send]').disabled, true);
  await f.submit(); assert.equal(sends, 1);
  pending.resolve({ message: message('new', 'ops'), push: { status: 'sent' } }); await submission;
  assert.equal(f.node('[data-message-send]').disabled, false);
});
