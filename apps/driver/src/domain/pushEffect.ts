import type { DriverPush } from './push';

export type PushEffect = {
  /** Reread the day (and with it the route): the operator changed the plan. */
  refreshDay: boolean;
  /** Reread the operator messages. */
  reloadMessages: boolean;
  /** Message ID to count as already seen, so the poll does not show its banner twice. */
  seenMessageId: string | null;
  banner: { title: string; body: string } | null;
  /** The driver tapped the notification: open the message list. */
  openMessages: boolean;
};

/** What the screen does when a push arrives; null for a push that belongs to another day or vehicle. */
export function pushEffect(push: DriverPush, scope: { date: string; vehicleId: string }): PushEffect | null {
  if (push.date !== scope.date || push.vehicleId !== scope.vehicleId) return null;
  if (push.kind === 'ops_message') {
    return {
      refreshDay: false,
      reloadMessages: true,
      seenMessageId: push.messageId,
      banner: { title: push.title, body: push.body },
      openMessages: push.tapped,
    };
  }
  return {
    refreshDay: true,
    reloadMessages: false,
    seenMessageId: null,
    banner: { title: '배차 변경', body: push.body || '배차가 변경되었습니다.' },
    openMessages: false,
  };
}
