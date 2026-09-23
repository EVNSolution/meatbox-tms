import assert from 'node:assert/strict';
import test from 'node:test';
import { browserGuidance, firebaseConfigured, inviteFromFragment, notificationIsActive, notificationUiState, shouldRefreshProvider, stageIndex, subscriptionHasConsent, toTimestamp, viewForDelivery } from './model.mjs';

test('Firebase 공개 설정이 비면 신청 불가로 분류한다', () => {
  assert.equal(firebaseConfigured(null), false);
  assert.equal(firebaseConfigured({ firebase:{ apiKey:'key', projectId:'project', appId:'app', messagingSenderId:'sender' } }), false);
  assert.equal(firebaseConfigured({ firebase:{ apiKey:'key', projectId:'project', appId:'app', messagingSenderId:'sender', vapidKey:'vapid' } }), true);
});

test('7단계별 근거 없는 위치·차량을 숨기고 입력된 ETA만 공개한다', () => {
  const time = { baselineAt:'2026-09-22T01:00:00Z', etaAt:'2026-09-22T02:00:00Z' };
  assert.deepEqual(viewForDelivery({ stage:'물류입고', ...time }), { index:2, unknown:false, showEta:false, etaError:false });
  assert.deepEqual(viewForDelivery({ stage:'배송대기', ...time }), { index:3, unknown:false, showEta:false, etaError:false });
  assert.equal(viewForDelivery({ stage:'근처 도착', ...time }).showEta, true);
  assert.equal(viewForDelivery({ stage:'배송 완료', ...time }).showEta, false);
  assert.equal(stageIndex('nearby'), 5);
});

test('배송 중과 근처 도착 ETA는 ISO와 epoch millisecond를 동일하게 처리한다', () => {
  const baselineAt = Date.parse('2026-09-22T01:00:00Z');
  const etaAt = Date.parse('2026-09-22T02:00:00Z');
  assert.equal(toTimestamp(etaAt), etaAt);
  assert.equal(viewForDelivery({ stage:'배송 중', baselineAt, etaAt }).showEta, true);
  assert.equal(viewForDelivery({ stage:'근처 도착', baselineAt:new Date(baselineAt).toISOString(), etaAt:new Date(etaAt).toISOString() }).showEta, true);
});

test('알 수 없는 단계는 결제완료로 대체하지 않는다', () => {
  const view = viewForDelivery({ stage:'mystery', baselineAt:1, etaAt:2 });
  assert.equal(view.index, -1);
  assert.equal(view.unknown, true);
  assert.equal(view.showEta, false);
});

test('서버 구독만으로 알림 받는 중이 되지 않는다', () => {
  assert.equal(notificationIsActive(true, { supported:true, permission:'denied' }, true), false);
  assert.equal(notificationIsActive(true, { supported:true, permission:'granted' }, false), false);
  assert.equal(notificationIsActive(true, { supported:true, permission:'granted' }, true), true);
});

test('provider 비활성 동의는 재등록하지만 철회된 동의는 재활성화하지 않는다', () => {
  const granted = { supported:true, permission:'granted' };
  const invalidProvider = { active:false, providerActive:false, consentActive:true };
  assert.equal(subscriptionHasConsent(invalidProvider), true);
  assert.equal(shouldRefreshProvider(invalidProvider, granted), true);
  assert.equal(notificationIsActive(invalidProvider.active, granted, true), false);
  assert.equal(shouldRefreshProvider({ active:false, providerActive:false, consentActive:false }, granted), false);
  assert.equal(shouldRefreshProvider(null, granted), false);
  assert.equal(notificationUiState({ subscription:null, capability:granted, providerReady:true }).label, '신청 전');
});

test('알림 배지의 8개 상태를 명시적으로 구분한다', () => {
  const granted = { supported:true, permission:'granted' };
  const label = input => notificationUiState(input).label;
  assert.equal(label({ capability:{ supported:false }, subscription:null }), '미지원');
  assert.equal(label({ capability:granted, subscription:null }), '신청 전');
  assert.equal(label({ capability:{ supported:true, permission:'denied' }, subscription:null }), '권한 거부');
  assert.equal(label({ capability:granted, subscription:null, phase:'registering' }), '등록 중');
  assert.equal(label({ capability:granted, subscription:{ active:true }, providerReady:true }), '알림 받는 중');
  assert.equal(label({ capability:granted, subscription:null, phase:'failed' }), '등록 실패');
  assert.equal(label({ capability:granted, subscription:{ status:'revoked' } }), '해제');
  assert.equal(label({ capability:granted, subscription:{ status:'expired' } }), '만료');
});

test('기준보다 과거인 ETA는 오류로 숨긴다', () => {
  const view = viewForDelivery({ stage:'배송 중', baselineAt:'2026-09-22T02:00:00Z', etaAt:'2026-09-22T01:00:00Z' });
  assert.equal(view.showEta, false);
  assert.equal(view.etaError, true);
});

test('초대 fragment와 플랫폼별 안내를 정규화한다', () => {
  assert.equal(inviteFromFragment('#inviteCode=secret'), 'secret');
  assert.equal(inviteFromFragment('#secret'), 'secret');
  assert.equal(inviteFromFragment('#%zz'), '');
  assert.match(browserGuidance({ webview:true }), /WebView/);
  assert.match(browserGuidance({ ios:true, standalone:false }), /홈 화면에 추가/);
  assert.match(browserGuidance({ supported:false }), /지원하지/);
});
