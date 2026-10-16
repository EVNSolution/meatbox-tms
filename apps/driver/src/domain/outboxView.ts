import type { OutboxItem } from '../outbox/Outbox';
import type { Stop } from './dispatch';
import { STOP_EVENT_TYPES } from './stopEvents';

/**
 * What the screen shows while events are still on the phone: a stop with a queued (or just sent, not yet reread)
 * completion is closed at once and the next waiting stop becomes the current one. A rejected event does not close
 * its stop, so the stop shows as open again until the driver decides. `queued` holds the keys of the closed stops
 * that the server has not confirmed yet.
 */
export function applyOutbox(stops: readonly Stop[], items: readonly OutboxItem[]): { stops: Stop[]; queued: Set<string> } {
  const closing = new Map<string, 'done' | 'skipped'>();
  const queued = new Set<string>();
  for (const item of items) {
    if (item.state === 'rejected' || !STOP_EVENT_TYPES.includes(item.type)) continue;
    const stop = stops.find((candidate) => candidate.orders.some((order) => order.id === item.stopId));
    if (!stop) continue;
    closing.set(stop.key, item.type === 'stop_failed' ? 'skipped' : 'done');
    if (item.state !== 'sent') queued.add(stop.key);
  }
  const shown = stops.map((stop) => {
    const status = closing.get(stop.key);
    return status ? { ...stop, status, arrived: false } : stop;
  });
  if (closing.size > 0 && !shown.some((stop) => stop.status === 'current')) {
    const next = shown.findIndex((stop) => stop.status === 'pending');
    if (next >= 0) shown[next] = { ...shown[next], status: 'current' };
  }
  return { stops: shown, queued };
}

const KIND_LABEL: Record<string, string> = {
  stop_completed: '배송 완료',
  stop_failed: '미배송',
  stop_partially_completed: '부분 완료',
};

export function outboxKindLabel(type: string): string {
  return KIND_LABEL[type] ?? type;
}

/** What to tell the driver about an item: waiting, or why it stopped and what can be done. */
export function outboxStatusText(item: OutboxItem): string {
  if (item.state === 'sent') return '전송됨';
  if (item.state === 'uploading') return '전송 중';
  if (item.state === 'pending') return item.attempts > 0 ? `연결을 기다리는 중 (${item.attempts}회 실패)` : '전송 대기';
  switch (item.reasonStatus) {
    case 401: return '로그인이 필요합니다. 다시 로그인한 뒤 "다시 시도"를 눌러 주세요.';
    case 403: return '이 작업을 처리할 권한이 없습니다. 운영팀에 알려 주세요.';
    case 409: return '서버의 배송 상태와 맞지 않습니다. 최신 상태를 확인한 뒤 삭제하거나 다시 시도해 주세요.';
    case 413: return '사진이 너무 큽니다. 삭제하고 사진을 다시 첨부해 주세요.';
    default: break;
  }
  if (item.reason === 'PHOTO_FILE_MISSING') return '사진 파일이 없어 보낼 수 없습니다. 삭제하고 다시 처리해 주세요.';
  return `서버가 거절했습니다 (${item.reason ?? '알 수 없음'}). 삭제하고 다시 처리해 주세요.`;
}
