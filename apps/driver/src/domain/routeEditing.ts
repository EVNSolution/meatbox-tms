import type { DriverRoute } from '../api/driverContracts';

/**
 * Why the order cannot be edited now, or null when it can. Before the departure every stop may move; after it only
 * the waiting stops may (the server refuses the rest with ROUTE_LOCKED). Reports still on the phone block the edit:
 * the screen already shows those stops as closed while the server still has them open, so the two lists would not
 * agree on which stops are waiting.
 */
export function editBlock(phase: DriverRoute['phase'], waitingReports: number): string | null {
  if (phase === 'done') return '운행이 끝난 경로의 순서는 바꿀 수 없습니다.';
  if (waitingReports > 0) return '전송 대기 중인 기록이 있어 순서를 바꿀 수 없습니다. 전송이 끝난 뒤 다시 시도해 주세요.';
  return null;
}
