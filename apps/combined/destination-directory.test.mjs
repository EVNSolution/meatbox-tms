import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDestinationDirectory } from './destination-directory.mjs';

const item = (id = 'site-private') => ({ id, name: '가락 <정육점>', address: '서울 송파구 가락로', detailAddress: '1층', regionNames: ['송파'], orderCount: 12, boxCount: 40, orderDays: 5, firstOrderDate: '2026-06-30', lastOrderDate: '2026-09-15' });
const payload = (date, extra = {}) => ({ date, fromDate: '2026-06-30', total: 21, page: 1, pageSize: 20, pageCount: 2, summary: { destinations: 21, orders: 150, boxes: 400 }, items: [item()], ...extra });
const response = data => ({ ok: true, json: async () => data });
const target = (key, value) => ({ closest: selector => selector === `[data-destination-${key}]` ? { dataset: { [`destination${key[0].toUpperCase()}${key.slice(1)}`]: value } } : null });

function fixture(fetchImpl) {
  const nodes = new Map();
  const element = {
    listeners: {}, innerHTML: '',
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', focus() {} });
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
  };
  const directory = mountDestinationDirectory({ element, fetchImpl });
  const node = key => element.querySelector(`[data-destination-${key}]`);
  return { directory, element, node };
}

test('누적 대장에 주문/박스/날짜를 표시하고 내부 ID나 운행 순서/상태는 노출하지 않는다', async () => {
  const calls = [];
  const { directory, element, node } = fixture(async url => { calls.push(url); return response(payload('2026-09-17')); });
  await directory.update('2026-09-17');
  await directory.update('2026-09-17');
  assert.equal(calls.length, 1, '실시간 상태 갱신으로 누적 자료를 반복 조회하지 않는다');
  assert.match(node('summary').innerHTML, /21곳/);
  assert.match(node('detail').innerHTML, /12건|40박스/);
  assert.match(node('detail').innerHTML, /가락 &lt;정육점&gt;/);
  const text = (element.innerHTML + node('list').innerHTML + node('detail').innerHTML).replace(/<[^>]+>/g, '');
  assert.doesNotMatch(text, /site-private|ID|번째|배송 중|운영 ETA/);
  assert.match(text, /최초 주문일|등록된 배송팁이 없습니다/);
  directory.destroy();
});

test('날짜 변경 전 응답과 데이터 해제 후 응답을 버리고 당일 주문으로 대체하지 않는다', async () => {
  const pending = [];
  const { directory, node } = fixture(() => new Promise(resolve => pending.push(resolve)));
  const first = directory.update('2026-09-16');
  const second = directory.update('2026-09-17');
  pending[1](response(payload('2026-09-17')));
  await second;
  pending[0](response(payload('2026-09-16', { summary: { destinations: 999 } })));
  await first;
  assert.match(node('period').textContent, /2026.09.17/);
  assert.doesNotMatch(node('summary').innerHTML, /999/);
  const third = directory.update('2026-09-18');
  await directory.update(null);
  pending[2](response(payload('2026-09-18')));
  await third;
  assert.equal(node('content').hidden, true);
  assert.equal(node('summary').innerHTML, '');
  assert.match(node('message').textContent, /자료가 연결되지/);
  directory.destroy();
});

test('검색 입력 즉시 이전 요청을 무효화하고 페이지를 1로 초기화한다', async () => {
  const calls = [];
  const pending = [];
  const { directory, element, node } = fixture(url => { calls.push(new URL(url, 'http://localhost')); return new Promise(resolve => pending.push(resolve)); });
  const initial = directory.update('2026-09-17');
  node('search').value = '가락 정육점';
  element.listeners.input({ target: node('search') });
  pending[0](response(payload('2026-09-17')));
  await initial;
  assert.equal(node('content').hidden, true);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls[1].searchParams.get('q'), '가락 정육점');
  assert.equal(calls[1].searchParams.get('page'), '1');
  pending[1](response(payload('2026-09-17', { total: 0, items: [] })));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(node('message').textContent, /검색한 배송지가 없습니다/);
  assert.equal(node('content').hidden, true);
  directory.destroy();
});

test('페이지 이동은 검색/운영일을 유지하며 미연결과 실패/재시도를 구분한다', async () => {
  let mode = 'missing';
  const calls = [];
  const { directory, element, node } = fixture(async url => {
    const params = new URL(url, 'http://localhost').searchParams;
    calls.push(params);
    if (mode === 'missing') return { ok: false, status: 404 };
    if (mode === 'error') throw new Error('offline');
    return response(payload(params.get('date'), { page: Number(params.get('page')), items: [item('second')] }));
  });
  await directory.update('2026-09-16');
  assert.match(node('message').innerHTML, /자료가 연결되지/);
  mode = 'error';
  await directory.update('2026-09-17');
  assert.match(node('message').innerHTML, /다시 불러오기/);
  mode = 'ready';
  await element.listeners.click({ target: target('retry', '') });
  await element.listeners.click({ target: target('page', 'next') });
  assert.equal(calls.at(-1).get('date'), '2026-09-17');
  assert.equal(calls.at(-1).get('page'), '2');
  assert.equal(node('page-label').textContent, '2 / 2');
  assert.equal(element.querySelector('[data-destination-page="next"]').disabled, true);
  directory.destroy();
});
