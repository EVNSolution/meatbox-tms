import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { FleetDelivery } from '../domain/dispatch';
import { matchPickupQr, pickupScanMessage, type PickupScanResult } from '../domain/pickupQr';
import { readPickupScans, savePickupScans } from '../storage';
import { Button, Card, T } from './common';
import { colors, radius, TOUCH_MIN } from './theme';

type Feedback = { tone: 'ok' | 'note' | 'error'; text: string };

export function PickupScreen({
  date,
  vehicleId,
  deliveries,
  allOrderIds,
  starting,
  onStart,
  onEditOrder,
}: {
  date: string;
  vehicleId: string;
  deliveries: FleetDelivery[];
  allOrderIds: ReadonlySet<string>;
  starting: boolean;
  onStart(): void;
  onEditOrder(): void;
}) {
  const scanRef = useRef<ReadonlySet<string>>(new Set());
  const [scanned, setScanned] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const vehicleOrderIds = useMemo(() => new Set(deliveries.map((d) => d.id)), [deliveries]);
  const confirmedCount = deliveries.filter((d) => scanned.has(d.id)).length;
  const allConfirmed = loaded && deliveries.length > 0 && confirmedCount === deliveries.length;

  useEffect(() => {
    let active = true;
    void readPickupScans(date, vehicleId).then((ids) => {
      if (active) { scanRef.current = new Set(ids); setScanned(scanRef.current); setLoaded(true); }
    });
    return () => {
      active = false;
    };
  }, [date, vehicleId]);

  function update(next: Set<string>) {
    scanRef.current = next;
    setScanned(next);
    void savePickupScans(date, vehicleId, [...next]).catch(() => setFeedback({ tone: 'error', text: '수령 확인을 저장하지 못했습니다. 앱을 종료하면 확인이 사라질 수 있습니다.' }));
  }

  function handleScan(raw: string): PickupScanResult {
    const result = matchPickupQr({ raw, date, vehicleOrderIds, allOrderIds, scanned: scanRef.current });
    const delivery = 'orderId' in result ? deliveries.find((d) => d.id === result.orderId) : undefined;
    const label = delivery ? `${delivery.name} ${delivery.orderNumber ?? ''}`.trim() : undefined;
    if (result.kind === 'ok') {
      update(new Set(scanRef.current).add(result.orderId));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setFeedback({ tone: 'ok', text: `✓ ${pickupScanMessage(result, label)}` });
    } else if (result.kind === 'already') {
      setFeedback({ tone: 'note', text: pickupScanMessage(result, label) });
    } else {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setFeedback({ tone: 'error', text: pickupScanMessage(result) });
    }
    return result;
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <Card style={styles.summary}>
          <T style={styles.title}>수령 확인</T>
          <T style={styles.progress}>{confirmedCount} / {deliveries.length} 주문</T>
          <View style={styles.bar}>
            <View style={[styles.barFill, { flex: confirmedCount }]} />
            <View style={{ flex: Math.max(0, deliveries.length - confirmedCount) }} />
          </View>
          <Button disabled={!loaded || starting || deliveries.length === 0} label="QR 스캔" onPress={() => setScannerOpen(true)} style={styles.scanButton} tone="action" />
          {feedback ? <T style={[styles.feedback, feedbackColor[feedback.tone]]}>{feedback.text}</T> : null}
          <T style={styles.note}>모든 주문의 QR을 확인하면 배송을 시작할 수 있습니다. 확인 내역은 이 기기에만 저장됩니다.</T>
          <Button disabled={starting} label="배송 순서 편집" onPress={onEditOrder} tone="secondary" />
        </Card>

        {deliveries.map((delivery) => {
          const checked = scanned.has(delivery.id);
          return (
            <View
              key={delivery.id}
              style={[styles.row, checked && styles.rowChecked]}
            >
              <T style={[styles.check, checked && styles.checkOn]}>{checked ? '✓' : '○'}</T>
              <View style={styles.rowCopy}>
                <T numberOfLines={1} style={styles.rowTitle}>{delivery.name}</T>
                <T style={styles.rowMeta}>{delivery.orderNumber ?? delivery.id} · {delivery.boxes}박스</T>
              </View>
            </View>
          );
        })}
      </ScrollView>
      <View style={styles.footer}>
        <Button
          busy={starting}
          disabled={!allConfirmed}
          label="배송 시작"
          onPress={onStart}
        />

      </View>
      {scannerOpen ? (
        <QrScanner
          feedback={feedback}
          onClose={() => setScannerOpen(false)}
          onScan={handleScan}
          progress={`${confirmedCount} / ${deliveries.length} 주문`}
        />
      ) : null}
    </View>
  );
}

function QrScanner({
  onScan,
  onClose,
  feedback,
  progress,
}: {
  onScan(raw: string): PickupScanResult;
  onClose(): void;
  feedback: Feedback | null;
  progress: string;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ raw: string; at: number } | null>(null);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  function onBarcodeScanned(result: BarcodeScanningResult) {
    const now = Date.now();
    // The camera reports the same code many times per second.
    if (last.current && last.current.raw === result.data && now - last.current.at < 2500) return;
    last.current = { raw: result.data, at: now };
    onScan(result.data);
  }

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <SafeAreaView style={styles.scanner}>
        <View style={styles.scannerHeader}>
          <T style={styles.scannerTitle}>QR 스캔 · {progress}</T>
          <Button label="닫기" onPress={onClose} style={styles.closeButton} tone="secondary" />
        </View>
        {permission?.granted ? (
          <CameraView
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            facing="back"
            onBarcodeScanned={onBarcodeScanned}
            style={styles.camera}
          />
        ) : (
          <View style={styles.cameraBlocked}>
            <T style={styles.blockedText}>카메라 권한이 필요합니다.</T>
            <Button label="권한 허용" onPress={() => void requestPermission()} tone="action" />
          </View>
        )}
        <View style={styles.scannerFooter}>
          <T style={[styles.scannerFeedback, feedback ? feedbackColor[feedback.tone] : null]}>
            {feedback?.text ?? '상자의 주문 QR을 화면 가운데에 맞춰 주세요.'}
          </T>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const feedbackColor = StyleSheet.create({
  ok: { color: colors.green },
  note: { color: colors.amber },
  error: { color: colors.error },
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { gap: 8, padding: 12, paddingBottom: 24 },
  summary: { gap: 10, marginBottom: 4 },
  title: { fontSize: 20, fontWeight: '800' },
  progress: { fontSize: 28, fontWeight: '800' },
  bar: { backgroundColor: colors.background, borderRadius: 4, flexDirection: 'row', height: 8, overflow: 'hidden' },
  barFill: { backgroundColor: colors.green },
  scanButton: { minHeight: 64 },
  feedback: { fontSize: 16, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 12 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.card,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 60,
    paddingLeft: 12,
  },
  rowChecked: { borderColor: colors.green },
  check: { color: colors.done, fontSize: 20, width: 24 },
  checkOn: { color: colors.green, fontWeight: '800' },
  rowCopy: { flex: 1, gap: 2, paddingVertical: 8 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowMeta: { color: colors.muted, fontSize: 13 },
  manual: { alignItems: 'center', justifyContent: 'center', minHeight: TOUCH_MIN, minWidth: 72, paddingHorizontal: 10 },
  manualText: { color: colors.action, fontSize: 13, fontWeight: '700' },
  footer: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 8,
    padding: 12,
  },
  scanner: { backgroundColor: colors.text, flex: 1 },
  scannerHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', padding: 12 },
  scannerTitle: { color: colors.surface, fontSize: 17, fontWeight: '700' },
  closeButton: { minHeight: TOUCH_MIN },
  camera: { flex: 1 },
  cameraBlocked: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
  blockedText: { color: colors.surface, fontSize: 16 },
  scannerFooter: { backgroundColor: colors.surface, minHeight: 72, justifyContent: 'center', padding: 16 },
  scannerFeedback: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
});
