import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { DayState } from '../domain/dispatch';
import { Button, Logo, T } from './common';
import { colors, radius, TOUCH_MIN } from './theme';

export function VehicleSelectScreen({
  date,
  state,
  error,
  onRetry,
  onSelect,
  onLogout,
}: {
  date: string;
  state: DayState | null;
  error: string | null;
  onRetry(): void;
  onSelect(vehicleId: string): void;
  onLogout(): void;
}) {
  const vehicles = state?.fleetVehicles ?? [];
  const countFor = (vehicleId: string) =>
    state?.fleetDeliveries.filter((delivery) => delivery.vehicleId === vehicleId).length ?? 0;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Logo />
        <Button label="로그아웃" onPress={onLogout} style={styles.headerButton} tone="secondary" />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <T style={styles.title}>차량 선택</T>
        <T style={styles.caption}>데모용 배송원 선택 · {date}</T>
        <T style={styles.caption}>실제 운영에서는 계정에 배정된 차량이 자동으로 정해집니다.</T>
        {error ? (
          <View style={styles.notice}>
            <T style={styles.error}>{error}</T>
            <Button label="다시 불러오기" onPress={onRetry} tone="action" />
          </View>
        ) : null}
        {!error && state === null ? <T style={styles.caption}>배차 정보를 불러오는 중입니다.</T> : null}
        {state !== null && vehicles.length === 0 ? (
          <T style={styles.caption}>오늘 배차된 차량이 없습니다.</T>
        ) : null}
        {vehicles.map((vehicle) => (
          <Pressable
            accessibilityRole="button"
            key={vehicle.id}
            onPress={() => onSelect(vehicle.id)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowCopy}>
              <T style={styles.driver}>{vehicle.driver || vehicle.id}</T>
              {vehicle.plate ? <T style={styles.plate}>{vehicle.plate} (미검증)</T> : null}
            </View>
            <T style={styles.count}>주문 {countFor(vehicle.id)}건</T>
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
  driver: { fontSize: 17, fontWeight: '700' },
  plate: { color: colors.muted, fontSize: 13 },
  count: { color: colors.action, fontSize: 15, fontWeight: '700' },
});
