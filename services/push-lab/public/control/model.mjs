export const STAGES = ['결제완료', '배송접수', '물류입고', '배송대기', '배송 중', '근처 도착', '배송 완료'];

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

export function statusText(status, senderMode = 'unknown') {
  if (!status) return '발송 없음';
  if (status === 'queued') return '대기 · 기기 미확인';
  if (status === 'retrying') return '재시도 중 · 기기 미확인';
  if (status === 'accepted') return `${senderMode === 'mock' ? 'mock' : senderMode === 'real' ? 'FCM' : '서버'} 접수 · 기기 미확인`;
  if (status === 'unknown') return '결과 불명 · 기기 미확인';
  if (status === 'failed') return '실패';
  if (status === 'cancelled') return '취소';
  return `${status} · 기기 미확인`;
}

export function errorText(code, status) {
  if (code === 'invalid_credentials') return '비밀번호가 올바르지 않습니다.';
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
