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
    showMap: index >= 3,
    showTruck: index >= 4 && index < 6,
    showEta: etaValid && index < 6,
    etaError: index >= 4 && delivery?.etaAt && !etaValid,
  };
}

export function inviteFromFragment(hash) {
  const value = hash.replace(/^#/, '');
  const params = new URLSearchParams(value);
  if (params.get('inviteCode') || params.get('invite') || params.get('code')) return params.get('inviteCode') || params.get('invite') || params.get('code');
  try { return !value.includes('=') ? decodeURIComponent(value) : ''; } catch { return ''; }
}

export function browserGuidance({ supported, ios, standalone, webview, permission }) {
  if (webview) return '앱 안의 WebView에서는 Web Push를 전제하지 않습니다. 주소를 복사해 지원 브라우저에서 열어 주세요.';
  if (ios && !standalone) return 'iPhone에서는 Safari 공유 메뉴의 “홈 화면에 추가” 후 설치된 Web App에서 열어 주세요.';
  if (!supported) return '이 환경은 Web Push 필수 기능을 지원하지 않습니다. Android의 최신 지원 브라우저 등에서 열어 주세요.';
  if (permission === 'denied') return '알림이 차단되어 있습니다. 브라우저 또는 기기 설정에서 이 사이트의 알림을 허용해 주세요.';
  return '체크 후 버튼을 누르면 브라우저가 별도로 알림 권한을 요청합니다.';
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
  return active ? { key:'receiving', label:'알림 받는 중', active:true }
    : { key:'idle', label:'신청 전', active:false };
}
