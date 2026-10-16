import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchVehicles } from '../api/driverApi';
import type { VehicleList } from '../api/driverContracts';
import { ApiError } from '../api/types';
import { onlyVehicle, vehicleChoices } from '../domain/vehiclesView';
import { Button, Logo, T } from './common';
import { colors, radius, TOUCH_MIN } from './theme';

type Loaded = { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; list: VehicleList };

export function VehicleSelectScreen({
  date,
  onSelect,
  onLogout,
  onSessionLost,
}: {
  date: string;
  onSelect(vehicleId: string): void;
  onLogout(): void;
  onSessionLost(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetchVehicles(date)
      .then((list) => { if (live) setLoaded({ status: 'ready', list }); })
      .catch((cause: unknown) => {
        if (!live) return;
        if (cause instanceof ApiError && cause.status === 401) onSessionLost();
        else setLoaded({ status: 'error', text: '차량 목록을 불러오지 못했습니다. 네트워크를 확인해 주세요.' });
      });
    return () => { live = false; };
  }, [attempt, date, onSessionLost]);
  const retry = () => { setLoaded({ status: 'loading' }); setAttempt((value) => value + 1); };
  const choices = useMemo(() => (loaded.status === 'ready' ? vehicleChoices(loaded.list) : []), [loaded]);
  const only = onlyVehicle(choices);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!only || opened.current === only) return;
    opened.current = only;
    onSelect(only);
  }, [only, onSelect]);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Logo />
        <Button label="로그아웃" onPress={onLogout} style={styles.headerButton} tone="secondary" />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <T style={styles.title}>차량 선택</T>
        <T style={styles.caption}>{date}</T>
        <T style={styles.caption}>계정에 배정된 차량만 표시됩니다.</T>
        {loaded.status === 'error' ? (
          <View style={styles.notice}>
            <T style={styles.error}>{loaded.text}</T>
            <Button label="다시 불러오기" onPress={retry} tone="action" />
          </View>
        ) : null}
        {loaded.status === 'loading' ? <ActivityIndicator color={colors.brand} /> : null}
        {loaded.status === 'ready' && !loaded.list.operable ? (
          <T style={styles.caption}>오늘 배차가 확정되면 배송을 시작할 수 있습니다.</T>
        ) : null}
        {loaded.status === 'ready' && choices.length === 0 ? <T style={styles.caption}>배정된 차량이 없습니다. 관제에 배정을 요청해 주세요.</T> : null}
        {choices.map((choice) => (
          <Pressable
            accessibilityRole="button"
            key={choice.vehicleId}
            onPress={() => onSelect(choice.vehicleId)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowCopy}>
              <T style={styles.driver}>{choice.title}</T>
              {choice.subtitle ? <T style={styles.plate}>{choice.subtitle}</T> : null}
            </View>
            <View style={styles.rowSide}>
              <T style={styles.count}>{choice.counts}</T>
              <T style={styles.phase}>{choice.phase}</T>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  header: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  headerButton: { minHeight: TOUCH_MIN, paddingHorizontal: 12 },
  body: { gap: 10, padding: 16 },
  title: { fontSize: 22, fontWeight: '800' },
  caption: { color: colors.muted, fontSize: 14 },
  notice: { gap: 10, marginVertical: 8 },
  error: { color: colors.error, fontSize: 15 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.card,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  pressed: { borderColor: colors.brand },
  rowCopy: { flex: 1, gap: 2 },
  rowSide: { alignItems: 'flex-end', gap: 2 },
  driver: { fontSize: 17, fontWeight: '700' },
  plate: { color: colors.muted, fontSize: 13 },
  count: { color: colors.action, fontSize: 15, fontWeight: '700' },
  phase: { color: colors.muted, fontSize: 12 },
});
