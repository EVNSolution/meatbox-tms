import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');

function clickWith(clients) {
  const handlers = new Map();
  const opened = [];
  const self = {
    location:{ origin:'https://demo.meatbox.co.kr' },
    addEventListener:(type, handler) => handlers.set(type, handler),
    clients:{ matchAll:async () => clients, openWindow:async url => { opened.push(url); } },
  };
  runInNewContext(source, { self, URL, encodeURIComponent });
  let completion;
  handlers.get('notificationclick')({
    notification:{ data:{ url:'/push-lab/?delivery=test-delivery' }, close() {} },
    waitUntil(value) { completion = value; },
  });
  return { completion, opened };
}

test('알림 클릭은 기존 TMS 및 관리자 탭을 바꾸지 않고 고객 탭만 재사용한다', async () => {
  const touched = [];
  const client = url => ({ url, navigate:async next => { touched.push([url, next]); return { focus:async () => {} }; } });
  const tms = client('https://demo.meatbox.co.kr/combined/#/control');
  const admin = client('https://demo.meatbox.co.kr/push-lab/control/');
  const customer = client('https://demo.meatbox.co.kr/push-lab/?delivery=old');
  const result = clickWith([tms, admin, customer]);
  await result.completion;
  assert.deepEqual(touched, [[customer.url, 'https://demo.meatbox.co.kr/push-lab/?delivery=test-delivery']]);
  assert.deepEqual(result.opened, []);
});

test('고객 탭이 없으면 새 창을 열고 다른 탭은 유지한다', async () => {
  const admin = { url:'https://demo.meatbox.co.kr/push-lab/control/', navigate:() => { throw new Error('must not navigate'); } };
  const result = clickWith([admin]);
  await result.completion;
  assert.deepEqual(result.opened, ['https://demo.meatbox.co.kr/push-lab/?delivery=test-delivery']);
});
