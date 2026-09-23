export const STAGES = ['결제완료', '배송접수', '물류입고', '배송대기', '배송 중', '근처 도착', '배송 완료'];

export function stageIndex(stage) {
  const aliases = { paid: 0, accepted: 1, received: 1, warehoused: 2, ready: 3, waiting: 3, shipping: 4, nearby: 5, completed: 6, delivered: 6 };
  if (Number.isInteger(stage) && stage >= 0 && stage < STAGES.length) return stage;
  return aliases[stage] ?? STAGES.indexOf(stage);
}

export function toTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

export function viewForDelivery(delivery) {
  const index = stageIndex(delivery?.stage);
  const unknown = index < 0;
  const baseline = toTimestamp(delivery?.baselineAt);
  const eta = toTimestamp(delivery?.etaAt);
  const etaValid = index >= 4 && Number.isFinite(eta) && Number.isFinite(baseline) && eta >= baseline;
  return {
    index,
    unknown,
    showEta: etaValid && index < 6,
    etaError: index >= 4 && delivery?.etaAt && !etaValid,
  };
}

export function inviteFromFragment(hash) {
  const value = hash.replace(/^#/, '');
  try {
    const entries = [...new URLSearchParams(value)];
    const code = entries.length === 1 && ['inviteCode', 'invite', 'code'].includes(entries[0][0])
      ? entries[0][1] : !value.includes('=') ? decodeURIComponent(value) : '';
    return /^[A-Za-z0-9_-]{1,128}$/.test(code) ? code : '';
  } catch { return ''; }
}

export function inviteFromUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname === '/push-lab/' && !url.search && !url.username && !url.password
      ? inviteFromFragment(url.hash) : '';
  } catch { return ''; }
}

export function browserGuidance({ supported, permission }) {
  if (!supported) return '현재 브라우저에서는 웹 알림을 사용할 수 없습니다. 배송 조회는 가능합니다.';
  if (permission === 'denied') return '알림이 차단되어 있습니다. 브라우저 또는 기기 설정에서 허용해 주세요.';
  return '';
}

export function firebaseConfigured(config) {
  return Boolean(config?.firebase && ['apiKey', 'projectId', 'appId', 'messagingSenderId', 'vapidKey']
    .every((key) => typeof config.firebase[key] === 'string' && config.firebase[key].trim()));
}

export function notificationIsActive(serverActive, capability, providerReady) {
  return Boolean(serverActive && capability.supported && capability.permission === 'granted' && providerReady);
}

export function subscriptionHasConsent(subscription) {
  const status = subscriptionStatus(subscription);
  return status === 'consented' || status === 'active';
}

export function shouldRefreshProvider(subscription, capability) {
  return subscriptionHasConsent(subscription) && capability.supported && capability.permission === 'granted';
}

export function subscriptionStatus(subscription, now = Date.now()) {
  if (!subscription) return 'none';
  if (['revoked', 'expired'].includes(subscription.status)) return subscription.status;
  if (subscription.active === true) return 'active';
  if (subscription.consentActive === true || subscription.subscribed === true) return 'consented';
  if (Number.isFinite(toTimestamp(subscription.expiresAt)) && toTimestamp(subscription.expiresAt) <= now) return 'expired';
  return 'revoked';
}

export function notificationUiState({ subscription, capability, providerReady, phase = '' }) {
  const status = subscriptionStatus(subscription);
  if (status === 'expired') return { key:'expired', label:'만료', active:false };
  if (status === 'revoked' || phase === 'unsubscribed') return { key:'unsubscribed', label:'해제', active:false };
  if (phase === 'registering') return { key:'registering', label:'등록 중', active:false };
  if (phase === 'failed') return { key:'failed', label:'등록 실패', active:false };
  if (!capability.supported) return { key:'unsupported', label:'미지원', active:false };
  if (capability.permission === 'denied') return { key:'denied', label:'권한 거부', active:false };
  const active = notificationIsActive(subscription?.active, capability, providerReady);
  return active ? { key:'registered', label:'알림 등록 완료', active:true }
    : { key:'idle', label:'신청 전', active:false };
}
