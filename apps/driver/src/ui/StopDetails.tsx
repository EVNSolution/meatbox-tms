import { StyleSheet, View } from 'react-native';

import { currentStopAction, type Stop } from '../domain/dispatch';
import { Button, SequenceBadge, T } from './common';
import { colors } from './theme';

export function stopTone(stop: Stop): 'current' | 'pending' | 'done' {
  if (stop.status === 'current') return 'current';
  return stop.status === 'pending' ? 'pending' : 'done';
}

const STATUS_LABEL = { current: '진행 중', pending: '대기', done: '완료', skipped: '보류' } as const;

export function StopDetails({
  stop,
  busy,
  onAction,
}: {
  stop: Stop;
  busy: boolean;
  onAction(action: 'arrive' | 'complete', stop: Stop): void;
}) {
  const action = currentStopAction(stop);
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <SequenceBadge tone={stopTone(stop)} value={stop.sequence} />
        <View style={styles.headCopy}>
          <T style={styles.name}>{stop.name}</T>
          <T style={styles.address}>{stop.address}</T>
          {stop.detailAddress ? <T style={styles.detail}>{stop.detailAddress}</T> : null}
        </View>
        <T style={[styles.status, stop.status === 'current' && styles.statusCurrent]}>
          {stop.status === 'current' && stop.arrived ? '도착' : STATUS_LABEL[stop.status]}
        </T>
      </View>
      <View style={styles.orders}>
        <T style={styles.ordersTitle}>주문 {stop.orders.length}건 · {stop.boxes}박스</T>
        {stop.orders.map((order) => (
          <View key={order.id} style={styles.orderRow}>
            <T style={styles.orderNo}>{order.orderNumber ?? order.id}</T>
            <T style={styles.orderBoxes}>{order.boxes}박스</T>
          </View>
        ))}
      </View>
      {action ? (
        <Button
          busy={busy}
          label={action === 'arrive' ? '도착' : '완료 · 다음'}
          onPress={() => onAction(action, stop)}
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  head: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  headCopy: { flex: 1, gap: 2 },
  name: { fontSize: 19, fontWeight: '800' },
  address: { color: colors.text, fontSize: 15 },
  detail: { color: colors.muted, fontSize: 14 },
  status: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  statusCurrent: { color: colors.blue },
  orders: { borderTopColor: colors.border, borderTopWidth: 1, gap: 4, paddingTop: 10 },
  ordersTitle: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  orderRow: { flexDirection: 'row', justifyContent: 'space-between' },
  orderNo: { fontSize: 14 },
  orderBoxes: { color: colors.muted, fontSize: 14 },
  action: { minHeight: 60 },
});
