// What the server says it told the drivers when an operator command moved a route. The push itself is asynchronous and
// only queued at that point, so the text never claims that a phone received anything.

export type DriverNotice = { vehicles: number; push: string; changes: { vehicleId: string; text: string }[] };

export function readDriverNotice(raw: unknown): DriverNotice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const notice = raw as Record<string, unknown>;
  if (typeof notice.vehicles !== 'number' || !Number.isInteger(notice.vehicles) || notice.vehicles < 1 || typeof notice.push !== 'string') return null;
  const changes = Array.isArray(notice.changes) ? notice.changes.flatMap((item: unknown) => {
    const change = item as Record<string, unknown> | null;
    return change && typeof change.vehicleId === 'string' && typeof change.text === 'string' ? [{ vehicleId: change.vehicleId, text: change.text }] : [];
  }) : [];
  return { vehicles: notice.vehicles, push: notice.push, changes };
}

export function driverNoticeText(notice: DriverNotice | null): string {
  if (!notice) return '';
  if (notice.push === 'queued') return `기사 알림 발송 ${notice.vehicles}대. 푸시를 요청했고 기기 수신은 확인되지 않습니다. 기사 앱은 다시 열 때 최신 경로를 읽습니다.`;
  if (notice.push === 'unconfigured') return `기사 알림 발송 0대. 푸시 설정이 없어 보내지 않았습니다(경로가 바뀐 차량 ${notice.vehicles}대). 기사 앱은 다시 열 때 최신 경로를 읽습니다.`;
  return `경로가 바뀐 차량 ${notice.vehicles}대. 기사 알림 상태를 확인하지 못했습니다.`;
}
