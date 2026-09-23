import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { authActions, authState, canSend, chooseSubscriptionId, deliveryValidity, errorText, inviteAccess, nextStage, statusText, STAGES } from './model.mjs';
import { ApiFailure, createControlApi, createRetryableAction, createTransientInviteLink } from './app.mjs';

test('화면 코드가 참조하는 요소 ID는 실제 HTML에 존재한다', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('./app.mjs', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, id] of app.matchAll(/\bel\('([^']+)'\)/g)) {
    assert.ok(ids.has(id), `missing HTML id: ${id}`);
  }
});

test('초대 링크를 공개 HTTPS 형식과 기기·내부망 주소로 구분한다', () => {
  assert.equal(inviteAccess('https://demo.meatbox.co.kr/push-lab/#invite=secret'), 'public-https');
  for (const host of ['localhost', '127.0.0.1', '192.168.1.3', '10.0.0.2', '172.20.0.4', 'device.local']) {
    assert.equal(inviteAccess(`http://${host}/push-lab/#invite=secret`), 'local');
  }
  assert.equal(inviteAccess('http://demo.meatbox.co.kr/push-lab/#invite=secret'), 'unverified');
  assert.equal(inviteAccess('https://100.64.0.1/push-lab/#invite=secret'), 'unverified');
  assert.equal(inviteAccess('https://100.127.255.254/push-lab/#invite=secret'), 'unverified');
  assert.equal(inviteAccess('https://push-lab.example.invalid/push-lab/#invite=secret'), 'unverified');
  assert.equal(inviteAccess('https://demo.meatbox.co.kr/other/#invite=secret'), 'unverified');
  assert.equal(inviteAccess('https://demo.meatbox.co.kr/push-lab/control/#invite=secret'), 'unverified');
  assert.equal(inviteAccess('https://demo.meatbox.co.kr/push-lab/?invite=secret'), 'unverified');
  assert.equal(inviteAccess('garbage'), 'unverified');
});

test('초대 링크는 발급과 재발급 원문만 복사하고 지우면 재조회할 수 없다', async () => {
  const copied = [];
  const link = createTransientInviteLink(async value => copied.push(value));
  assert.equal(link.get(), '');
  assert.equal(await link.copy(), false);
  const first = 'https://demo.meatbox.co.kr/push-lab/#invite=first';
  const second = 'https://demo.meatbox.co.kr/push-lab/#invite=second';
  assert.equal(link.issue({ url:first }), 'public-https');
  assert.equal(link.issue({ url:second }), 'public-https');
  assert.equal(await link.copy(), true);
  assert.deepEqual(copied, [second]);
  link.clear();
  assert.equal(link.get(), '');
  assert.equal(await link.copy(), false);
});

test('링크는 발급 직후 현재 상태에만 있고 오류나 상세 전환 시 지울 수 있다', async () => {
  const copied = [];
  const link = createTransientInviteLink(async value => copied.push(value));
  const url = 'https://demo.meatbox.co.kr/push-lab/#invite=one-time-secret';
  link.issue({ url });
  assert.equal(link.get(), url);
  assert.deepEqual(copied, []);
  link.clear();
  assert.equal(link.get(), '');
  assert.equal(await link.copy(), false);
  assert.deepEqual(copied, []);
});

test('7단계는 바로 다음 단계만 노출하고 완료 시 발송을 막는다', () => {
  for (let index = 0; index < STAGES.length - 1; index++) assert.equal(nextStage(STAGES[index]), STAGES[index + 1]);
  assert.equal(nextStage('배송 완료'), null);
  assert.equal(nextStage('알 수 없음'), null);
  const delivery = { stage:'배송대기', expiresAt:2_000, revision:1 };
  const subscription = { id:'sub-1', status:'active', providerActive:true, expiresAt:1_500 };
  assert.equal(canSend(delivery, subscription, 1_000), true);
  assert.equal(canSend(delivery, null, 1_000), false);
  assert.equal(canSend(delivery, { ...subscription, providerActive:false }, 1_000), false);
  assert.equal(canSend(delivery, { ...subscription, status:'revoked' }, 1_000), false);
  assert.equal(canSend(delivery, subscription, 1_500), false);
  assert.equal(canSend({ ...delivery, stage:'배송 완료' }, subscription, 1_000), false);
  assert.equal(deliveryValidity(delivery, 2_000), '만료');
});

test('보낼 수 있는 기기 하나만 자동 선택하고 여러 기기는 명시적으로 고르게 한다', () => {
  const delivery = { stage:'배송대기', expiresAt:2_000 };
  const active = (id) => ({ id, status:'active', providerActive:true, expiresAt:1_500 });
  assert.equal(chooseSubscriptionId(delivery, [], '', 1_000), '');
  assert.equal(chooseSubscriptionId(delivery, [active('one')], '', 1_000), 'one');
  assert.equal(chooseSubscriptionId(delivery, [active('one'), active('two')], '', 1_000), '');
  assert.equal(chooseSubscriptionId(delivery, [active('one'), active('two')], 'two', 1_000), 'two');
  assert.equal(chooseSubscriptionId(delivery, [active('one'), { ...active('two'), providerActive:false }], 'two', 1_000), 'one');
  assert.equal(chooseSubscriptionId({ ...delivery, stage:'배송 완료' }, [active('one')], '', 1_000), '');
});

test('접수/대기 상태는 짧게 표시하되 기기 수신이나 표시로 표현하지 않는다', () => {
  assert.equal(statusText('queued'), '발송 대기');
  assert.equal(statusText('retrying'), '재시도 중');
  assert.equal(statusText('accepted'), '서버 처리 완료');
  assert.equal(statusText('unknown'), '결과 불명');
  assert.doesNotMatch(statusText('accepted'), /수신|표시|전달/);
  assert.match(errorText('invalid_credentials', 401), /비밀번호/);
});

test('TMS 세션 인증 상태는 로그인, 권한 없음, 연결 실패를 구분한다', () => {
  assert.equal(authState({ status:401, code:'admin_session_required' }, 'tms'), 'login');
  assert.equal(authState({ status:403, code:'admin_forbidden' }, 'tms'), 'forbidden');
  assert.equal(authState({ status:503, code:'tms_auth_unavailable' }, 'tms'), 'unavailable');
  assert.equal(authState(new TypeError('network'), 'tms'), 'unavailable');
  assert.equal(authState({ status:401 }, 'unknown'), 'unavailable');
  assert.deepEqual(authActions('login', 'tms'), { password:false, tmsLogin:true, retry:true });
  assert.deepEqual(authActions('forbidden', 'tms'), { password:false, tmsLogin:false, retry:true });
  assert.deepEqual(authActions('unavailable', 'tms'), { password:false, tmsLogin:false, retry:true });
  assert.deepEqual(authActions('login', 'password'), { password:true, tmsLogin:false, retry:false });
  assert.match(errorText('admin_session_required', 401), /TMS/);
  assert.match(errorText('admin_forbidden', 403), /권한/);
  assert.match(errorText('tms_auth_unavailable', 503), /일시적으로/);
});

test('API는 세션 쿠키를 사용하고 CSRF는 메모리의 POST 헤더에만 실으며 오류를 분류한다', async () => {
  const requests = [];
  const api = createControlApi(async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/deliveries')) return { ok:false, status:409, json:async () => ({ error:'revision_conflict' }) };
    return { ok:true, status:200, json:async () => ({ authenticated:true }) };
  });
  api.setCsrf('session-secret');
  await api.request('/session');
  await assert.rejects(api.request('/deliveries', { method:'POST', csrfToken:'override-secret', body:{ userId:'test-a' } }), ApiFailure);
  await assert.rejects(api.request('/deliveries', { method:'POST', body:{} }), (error) => error instanceof ApiFailure && error.status === 409);
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.headers['X-CSRF-Token'], undefined);
  assert.equal(requests[1].options.headers['X-CSRF-Token'], 'override-secret');
  assert.equal(requests[2].options.headers['X-CSRF-Token'], 'session-secret');
  assert.equal(requests[2].url, '/push-lab/control/api/deliveries');
});

test('네트워크 오류 후 같은 eventId를 재사용하고 서버 오류 뒤에는 새 동작으로 취급한다', async () => {
  const action = createRetryableAction();
  const seen = [];
  await assert.rejects(action.run('stage:1', { stage:'배송접수', expectedRevision:1 }, async (body) => {
    seen.push(body);
    throw new TypeError('network');
  }), /network/);
  await assert.rejects(action.run('stage:1', { stage:'배송접수', expectedRevision:1 }, async (body) => {
    seen.push(body);
    throw new ApiFailure(409, 'revision_conflict');
  }), ApiFailure);
  assert.equal(seen[0].eventId, seen[1].eventId);
  await action.run('stage:1', { stage:'배송접수', expectedRevision:1 }, async (body) => { seen.push(body); return { ok:true }; });
  assert.notEqual(seen[1].eventId, seen[2].eventId);
});

test('단일 대상 발송 동작은 subscriptionId와 expectedRevision을 유지하고 자동 발송하지 않는다', async () => {
  const action = createRetryableAction();
  const sent = [];
  await action.run('delivery:4:sub-one', { subscriptionId:'sub-one', expectedRevision:4 }, async body => {
    sent.push(body);
    return { status:'queued' };
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subscriptionId, 'sub-one');
  assert.equal(sent[0].expectedRevision, 4);
  assert.equal(typeof sent[0].eventId, 'string');
  assert.equal('fid' in sent[0], false);
});
