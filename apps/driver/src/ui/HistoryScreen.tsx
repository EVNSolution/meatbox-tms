import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchHistory } from '../api/driverApi';
import type { Stop } from '../domain/dispatch';
import type { HistoryItem } from '../api/driverContracts';
import { historyRows } from '../domain/historyView';
import { Button, T } from './common';
import { colors, radius } from './theme';

type Loaded = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: HistoryItem[] };

// Today's finished stops as the server recorded them (the source of truth), newest first.
export function HistoryScreen({
  date,
  vehicleId,
  stops,
  waiting,
  onClose,
}: {
  date: string;
  vehicleId: string;
  stops: readonly Stop[];
  /** Reports still on the phone; they appear here once the server has them. */
  waiting: number;
  onClose(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetchHistory(date, vehicleId)
      .then((items) => { if (live) setLoaded({ status: 'ready', items }); })
      .catch(() => { if (live) setLoaded({ status: 'error' }); });
    return () => { live = false; };
  }, [attempt, date, vehicleId]);
  const rows = useMemo(() => (loaded.status === 'ready' ? historyRows(loaded.items, stops) : []), [loaded, stops]);
  const retry = () => { setLoaded({ status: 'loading' }); setAttempt((value) => value + 1); };

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <T style={styles.title}>오늘 배송 이력</T>
          <Button label="닫기" onPress={onClose} tone="secondary" />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {waiting > 0 ? <T style={styles.notice}>전송 대기 {waiting}건은 서버에 전달되면 여기에 나타납니다.</T> : null}
          {loaded.status === 'loading' ? <ActivityIndicator color={colors.brand} /> : null}
          {loaded.status === 'error' ? (
            <View style={styles.group}>
              <T accessibilityRole="alert" style={styles.error}>이력을 불러오지 못했습니다.</T>
              <Button label="다시 불러오기" onPress={retry} tone="secondary" />
            </View>
          ) : null}
          {loaded.status === 'ready' && rows.length === 0 ? <T style={styles.muted}>아직 완료한 배송지가 없습니다.</T> : null}
          {loaded.status === 'ready' ? rows.map((row) => (
            <View key={row.key} style={[styles.card, row.tone === 'failed' && styles.cardFailed]}>
              <View style={styles.line}>
                <T numberOfLines={1} style={styles.name}>{row.name}</T>
                <T style={styles.time}>{row.time ?? '--:--'}</T>
              </View>
              <T style={[styles.result, row.tone === 'failed' && styles.resultFailed]}>
                {row.result}{row.reason ? ` · ${row.reason}` : ''}{row.photos > 0 ? ` · 사진 ${row.photos}장` : ''}
              </T>
              {row.note ? <T style={styles.note}>{row.note}</T> : null}
            </View>
          )) : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  header: { alignItems: 'center', backgroundColor: colors.surface, flexDirection: 'row', justifyContent: 'space-between', padding: 12 },
  title: { fontSize: 17, fontWeight: '800' },
  body: { gap: 10, padding: 12 },
  group: { gap: 8 },
  notice: { color: colors.amber, fontSize: 13 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.error, fontSize: 14 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.card, borderWidth: 1, gap: 4, padding: 12 },
  cardFailed: { borderColor: colors.error },
  line: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  name: { flex: 1, fontSize: 16, fontWeight: '800' },
  time: { color: colors.muted, fontSize: 14 },
  result: { color: colors.green, fontSize: 14, fontWeight: '700' },
  resultFailed: { color: colors.error },
  note: { color: colors.text, fontSize: 14 },
});
