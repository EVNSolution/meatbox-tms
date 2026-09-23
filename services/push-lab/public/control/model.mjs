export const STAGES = ['결제완료', '배송접수', '물류입고', '배송대기', '배송 중', '근처 도착', '배송 완료'];

export function inviteAccess(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return 'unverified'; }
  const host = url.hostname.toLowerCase();
  const octets = host.split('.').map(Number);
  const ipv4 = octets.length === 4 && octets.every((part, index) => /^\d{1,3}$/.test(host.split('.')[index]) && part >= 0 && part <= 255);
  const privateIp = ipv4 && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254
    || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168);
  const carrierNat = ipv4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateIp || host === '[::1]') return 'local';
  if (carrierNat || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/push-lab/' || url.search || !url.hash.startsWith('#invite=')
    || /\.(?:invalid|test|example|internal)$/.test(host) || (host.includes(':') && !ipv4)) return 'unverified';
  return 'public-https';
}

export function nextStage(stage) {
  const index = STAGES.indexOf(stage);
  return index < 0 || index >= STAGES.length - 1 ? null : STAGES[index + 1];
}

export function deliveryValidity(delivery, now = Date.now()) {
  return Number(delivery?.expiresAt) <= now ? '만료' : '유효';
}

export function canSend(delivery, subscription, now = Date.now()) {
  return Boolean(delivery && subscription && deliveryValidity(delivery, now) === '유효'
    && nextStage(delivery.stage) && subscription.status === 'active'
    && subscription.providerActive === true && Number(subscription.expiresAt) > now);
}

export function chooseSubscriptionId(delivery, subscriptions, previousId = '', now = Date.now()) {
  const eligible = subscriptions.filter((item) => canSend(delivery, item, now));
  if (eligible.some((item) => item.id === previousId)) return previousId;
  return eligible.length === 1 ? eligible[0].id : '';
}

export function statusText(status) {
  if (!status) return '발송 없음';
  if (status === 'queued') return '발송 대기';
  if (status === 'retrying') return '재시도 중';
  if (status === 'accepted') return '서버 처리 완료';
  if (status === 'unknown') return '결과 불명';
  if (status === 'failed') return '실패';
  if (status === 'cancelled') return '취소';
  if (status === 'expired') return '만료';
  return '상태 미확인';
}

export function authState(error, mode) {
  if (mode === 'unknown') return 'unavailable';
  if (error?.status === 401) return 'login';
  if (mode === 'tms' && error?.status === 403 && error?.code === 'admin_forbidden') return 'forbidden';
  return 'unavailable';
}

export function authActions(state, mode) {
  return {
    password: mode === 'password' && state === 'login',
    tmsLogin: mode === 'tms' && state === 'login',
    retry: state !== 'login' || mode === 'tms',
  };
}

export function errorText(code, status) {
  if (code === 'invalid_credentials') return '비밀번호가 올바르지 않습니다.';
  if (code === 'admin_session_required') return '기존 TMS 계정으로 로그인해 주세요.';
  if (code === 'admin_forbidden') return '현재 TMS 계정에는 TEST 관제 권한이 없습니다.';
  if (code === 'tms_auth_unavailable') return 'TMS 인증 서비스에 일시적으로 연결할 수 없습니다. 잠시 후 다시 확인해 주세요.';
  if (status === 401) return '관리자 세션이 만료되었습니다. 다시 로그인해 주세요.';
  if (status === 403) return '보안 확인에 실패했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.';
  if (status === 404) return '대상을 찾을 수 없습니다. 목록을 새로고침해 주세요.';
  if (status === 409) return '다른 변경과 충돌했습니다. 배송 상세를 새로고침해 주세요.';
  if (status === 410) return 'TEST 배송이 만료되었습니다.';
  if (status === 429) return '로그인 시도가 제한되었습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'admin_unconfigured') return '관리자 비밀 설정이 없어 로그인할 수 없습니다.';
  if (status === 400) return '입력값을 확인해 주세요.';
  return '요청에 실패했습니다. 다시 시도해 주세요.';
}
