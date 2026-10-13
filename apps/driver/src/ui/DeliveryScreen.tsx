import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import type { Stop } from '../domain/dispatch';
import { Button, Card, SequenceBadge, T } from './common';
import { StopDetails, stopTone } from './StopDetails';
import { colors, radius, TOUCH_MIN } from './theme';

export function DeliveryScreen({
  stops,
  busy,
  refreshing,
  onRefresh,
  onAction,
  onEditOrder,
}: {
  stops: Stop[];
  busy: boolean;
  refreshing: boolean;
  onRefresh(): void;
  onAction(action: 'arrive' | 'complete', stop: Stop): void;
  onEditOrder(): void;
}) {
  const [showDone, setShowDone] = useState(false);
  const current = stops.find((stop) => stop.status === 'current') ?? null;
  const pending = stops.filter((stop) => stop.status === 'pending');
  const finished = stops.filter((stop) => stop.status === 'done' || stop.status === 'skipped');

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl colors={[colors.brand]} onRefresh={onRefresh} refreshing={refreshing} />}
    >
      {current ? (
        <Card style={styles.currentCard}>
          <T style={styles.sectionLabel}>현재 배송지</T>
          <StopDetails busy={busy} onAction={onAction} stop={current} />
        </Card>
      ) : (
        <Card>
          <T style={styles.emptyTitle}>{pending.length === 0 ? '오늘 배송을 모두 마쳤습니다.' : '진행 중인 배송지가 없습니다.'}</T>
        </Card>
      )}

      <View style={styles.sectionHead}>
        <T style={styles.sectionTitle}>남은 배송지 {pending.length}곳</T>
        {pending.length > 1 ? (
          <Button label="순서 편집" onPress={onEditOrder} style={styles.editButton} tone="secondary" />
        ) : null}
      </View>
      {pending.map((stop) => <StopRow key={stop.key} stop={stop} />)}

      {finished.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showDone }}
          onPress={() => setShowDone((value) => !value)}
          style={styles.doneToggle}
        >
          <T style={styles.doneToggleText}>완료 {finished.length}곳 {showDone ? '접기' : '보기'}</T>
        </Pressable>
      ) : null}
      {showDone ? finished.map((stop) => <StopRow key={stop.key} stop={stop} />) : null}
    </ScrollView>
  );
}

function StopRow({ stop }: { stop: Stop }) {
  const done = stop.status === 'done' || stop.status === 'skipped';
  return (
    <View style={[styles.row, done && styles.rowDone]}>
      <SequenceBadge tone={stopTone(stop)} value={stop.sequence} />
      <View style={styles.rowCopy}>
        <T numberOfLines={1} style={[styles.rowName, done && styles.mutedText]}>{stop.name}</T>
        <T numberOfLines={1} style={styles.rowAddress}>{stop.address}</T>
      </View>
      <T style={styles.rowMeta}>
        {stop.status === 'skipped' ? '보류' : `${stop.orders.length}건 · ${stop.boxes}박스`}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 8, padding: 12, paddingBottom: 32 },
  currentCard: { borderColor: colors.brand, borderWidth: 2, gap: 8 },
  sectionLabel: { color: colors.brand, fontSize: 13, fontWeight: '800' },
  emptyTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  sectionHead: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '800' },
  editButton: { minHeight: TOUCH_MIN, paddingHorizontal: 12 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.card,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 60,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowDone: { backgroundColor: colors.background },
  rowCopy: { flex: 1, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '700' },
  mutedText: { color: colors.muted },
  rowAddress: { color: colors.muted, fontSize: 13 },
  rowMeta: { color: colors.muted, fontSize: 13 },
  doneToggle: { alignItems: 'center', justifyContent: 'center', marginTop: 8, minHeight: TOUCH_MIN },
  doneToggleText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
});
