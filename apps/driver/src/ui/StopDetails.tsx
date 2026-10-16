import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Stop } from '../domain/dispatch';
import { targetOf } from '../domain/navigation';
import type { EtaLabel } from '../domain/routeView';
import { Button, SequenceBadge, T } from './common';
import { NavigationButton } from './NavigationButton';
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
  eta = null,
  info = null,
}: {
  stop: Stop;
  busy: boolean;
  onAction(action: 'arrive' | 'complete', stop: Stop): void;
  eta?: EtaLabel | null;
  info?: ReactNode;
}) {
  const action = stop.status === 'current' ? 'complete' : null;
  const navigable = stop.status === 'current' || stop.status === 'pending';
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
          {STATUS_LABEL[stop.status]}
        </T>
      </View>
      {eta ? <T style={[styles.eta, eta.dimmed && styles.etaDimmed]}>{eta.text}</T> : null}
      <View style={styles.orders}>
        <T style={styles.ordersTitle}>주문 {stop.orders.length}건 · {stop.boxes}박스</T>
        {stop.orders.map((order) => (
          <View key={order.id} style={styles.orderRow}>
            <T style={styles.orderNo}>{order.orderNumber ?? order.id}</T>
            <T style={styles.orderBoxes}>{order.boxes}박스</T>
          </View>
        ))}
      </View>
      {navigable ? <NavigationButton target={targetOf(stop)} /> : null}
      {info}
      {action ? (
        <Button
          busy={busy}
          label="완료 · 미배송 처리"
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
  eta: { color: colors.blue, fontSize: 14, fontWeight: '700' },
  etaDimmed: { color: colors.muted, fontWeight: '400', opacity: 0.7 },
  orders: { borderTopColor: colors.border, borderTopWidth: 1, gap: 4, paddingTop: 10 },
  ordersTitle: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  orderRow: { flexDirection: 'row', justifyContent: 'space-between' },
  orderNo: { fontSize: 14 },
  orderBoxes: { color: colors.muted, fontSize: 14 },
  action: { minHeight: 60 },
});
