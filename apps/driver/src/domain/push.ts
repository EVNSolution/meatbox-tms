export type DriverPush = {
  kind: 'ops_message' | 'route_changed';
  messageId: string;
  title: string;
  body: string;
  date: string;
  vehicleId: string;
  tapped: boolean;
};

export function parsePushData(
  data: Record<string, unknown>,
  fallback: { title?: string | null; body?: string | null },
  tapped: boolean,
): DriverPush | null {
  if (data.type !== 'ops_message' && data.type !== 'route_changed') return null;
  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(data.date)
    || typeof data.vehicleId !== 'string' || !data.vehicleId) return null;
  return {
    kind: data.type,
    messageId: typeof data.messageId === 'string' ? data.messageId : '',
    title: typeof data.title === 'string' ? data.title : fallback.title ?? '운영팀 메시지',
    body: typeof data.body === 'string' ? data.body : fallback.body ?? '',
    date: data.date,
    vehicleId: data.vehicleId,
    tapped,
  };
}
