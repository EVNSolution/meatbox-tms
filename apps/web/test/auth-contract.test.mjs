import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticationDestination,
  encodeFormValues,
  fallbackFeedback,
  safeProductPath,
  sameOriginPath,
  serverFeedback,
} from '../src/auth-contract.ts';

test('product redirects retain allowed query and hash while rejecting open redirects', () => {
  assert.equal(safeProductPath('/combined/?date=2026-10-05#/customer'), '/combined/?date=2026-10-05#/customer');
  for (const unsafe of ['/scenario/driver?route=A%201#stop-2', '//evil.invalid', '/\\evil.invalid', 'https://evil.invalid/path', '/login', '/dev/register', '/combined\r\nX-Test: bad']) {
    assert.equal(safeProductPath(unsafe), '/');
  }
});

test('same-origin response paths reject foreign redirect locations', () => {
  assert.equal(sameOriginPath('https://test.meatbox.local/login?registered=1', 'https://test.meatbox.local'), '/login?registered=1');
  assert.equal(sameOriginPath('https://evil.invalid/combined/', 'https://test.meatbox.local'), null);
  assert.equal(sameOriginPath('https://user:password@test.meatbox.local/combined/', 'https://test.meatbox.local'), null);
});

test('successful login retains the submitted fragment even after fetch follows the root alias', () => {
  const origin = 'https://test.meatbox.local';
  assert.equal(authenticationDestination('login', `${origin}/combined/?date=2026-10-05`, origin, '/combined/?date=2026-10-05#driver'), '/combined/?date=2026-10-05#driver');
  assert.equal(authenticationDestination('login', `${origin}/combined/`, origin, '/#customer'), '/#customer');
  assert.equal(authenticationDestination('login', `${origin}/login`, origin, '/combined/'), null);
  assert.equal(authenticationDestination('login', 'https://evil.invalid/combined/', origin, '/combined/'), null);
  assert.equal(authenticationDestination('register', `${origin}/login?registered=1`, origin), '/login?registered=1');
  assert.equal(authenticationDestination('register', `${origin}/login?next=//evil.invalid`, origin), null);
});

test('urlencoded forms preserve query-like values and encode control characters', () => {
  const encoded = encodeFormValues([
    ['next', '/combined/?date=2026-10-05&mode=driver#/route'],
    ['displayName', '검토자\r\n이름\u0000'],
  ]);
  assert.equal(encoded, 'next=%2Fcombined%2F%3Fdate%3D2026-10-05%26mode%3Ddriver%23%2Froute&displayName=%EA%B2%80%ED%86%A0%EC%9E%90%0D%0A%EC%9D%B4%EB%A6%84%00');
});

test('registration succeeds when an existing session follows the login redirect to the product', () => {
  const origin = 'http://127.0.0.1:4173';
  assert.equal(authenticationDestination('register', `${origin}/combined/`, origin), '/combined/');
  assert.equal(authenticationDestination('register', `${origin}/combined/?unexpected=1`, origin), null);
  assert.equal(authenticationDestination('register', 'https://foreign.invalid/combined/', origin), null);
});

test('fallback messages keep authentication status boundaries distinct', () => {
  assert.equal(fallbackFeedback('login', 401).form, '아이디와 비밀번호를 확인해 주세요.');
  assert.equal(fallbackFeedback('register', 400).form, '입력값을 확인해 주세요.');
  assert.equal(fallbackFeedback('login', 403).form, '로그인 페이지에서 다시 시도해 주세요.');
  assert.match(fallbackFeedback('register', 429).form, /접근 요청/);
  assert.match(fallbackFeedback('login', 500).form, /서버에 연결/);
});

test('server feedback accepts only current static auth messages without echoing submitted secrets', () => {
  assert.deepEqual(serverFeedback('register', 400, '입력값을 확인해 주세요.', {
    invite: '초대 코드가 유효하지 않거나 이미 사용되었습니다.',
    username: '이미 사용 중인 아이디입니다.',
    password: '비밀번호를 8~128자로 입력해 주세요.',
  }), {
    form: '입력값을 확인해 주세요.',
    fields: {
      invite: '초대 코드가 유효하지 않거나 이미 사용되었습니다.',
      username: '이미 사용 중인 아이디입니다.',
      password: '비밀번호를 8~128자로 입력해 주세요.',
    },
  });

  for (const status of [400, 403, 429, 500]) {
    const feedback = serverFeedback('register', status, 'reflected-password-and-invite', {
      invite: 'reflected-invite', password: 'reflected-password', unknown: 'reflected-unknown',
    });
    assert.deepEqual(feedback.fields, {});
    assert.doesNotMatch(feedback.form, /reflected/);
  }
  assert.deepEqual(serverFeedback('login', 401, 'reflected-password', { password: 'reflected-password' }), fallbackFeedback('login', 401));
});
