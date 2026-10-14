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
  const [latestId, setLatestId] = useState<string | null>(null);
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
      setLatestId(result.orderId);
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
          const scanNumber = checked ? [...scanned].indexOf(delivery.id) + 1 : 0;
          return (
            <View
              key={delivery.id}
              style={[styles.row, checked && styles.rowChecked]}
            >
              <T style={[styles.check, checked && styles.checkOn]}>{checked ? '✓' : '○'}</T>
              {checked ? <T style={styles.scanNumber}>#{scanNumber}</T> : null}
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
          deliveries={deliveries}
          feedback={feedback}
          latestId={latestId}
          onClose={() => setScannerOpen(false)}
          onScan={handleScan}
          scanned={scanned}
        />
      ) : null}
    </View>
  );
}

// Scanning is never throttled: several QR codes in view are all accepted. The panel makes the
// result legible instead, listing confirmed orders newest first with the order they were scanned in.
function QrScanner({
  onScan,
  onClose,
  feedback,
  deliveries,
  scanned,
  latestId,
}: {
  onScan(raw: string): PickupScanResult;
  onClose(): void;
  feedback: Feedback | null;
  deliveries: FleetDelivery[];
  scanned: ReadonlySet<string>;
  latestId: string | null;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ raw: string; at: number } | null>(null);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const byId = useMemo(() => new Map(deliveries.map((d) => [d.id, d])), [deliveries]);
  const confirmed = [...scanned].filter((id) => byId.has(id));
  const remaining = deliveries.filter((d) => !scanned.has(d.id));
  const complete = deliveries.length > 0 && remaining.length === 0;

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
          <T style={styles.scannerTitle}>수령 QR 스캔</T>
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
          <View style={[styles.camera, styles.cameraBlocked]}>
            <T style={styles.blockedText}>카메라 권한이 필요합니다.</T>
            <Button label="권한 허용" onPress={() => void requestPermission()} tone="action" />
          </View>
        )}
        <View style={styles.panel}>
          <View style={styles.panelHead}>
            <T style={[styles.counter, complete && styles.counterDone]}>{confirmed.length}<T style={styles.counterTotal}> / {deliveries.length}</T></T>
            <T style={[styles.counterLabel, complete && styles.counterDone]}>{complete ? '모두 확인됨' : `남은 주문 ${remaining.length}`}</T>
          </View>
          <View style={styles.bar}>
            <View style={[styles.barFill, { flex: confirmed.length }]} />
            <View style={{ flex: remaining.length }} />
          </View>
          {feedback && feedback.tone !== 'ok' ? (
            <T style={[styles.notice, feedback.tone === 'error' ? styles.noticeError : styles.noticeNote]}>{feedback.text}</T>
          ) : null}
          <ScrollView contentContainerStyle={styles.panelList}>
            {confirmed.length ? <T style={styles.section}>확인됨 · 최근 순</T> : <T style={styles.hint}>상자의 주문 QR을 비추면 여기에 확인한 순서대로 쌓입니다.</T>}
            {confirmed.slice().reverse().map((id) => {
              const delivery = byId.get(id)!;
              const latest = id === latestId;
              return (
                <View key={id} style={[styles.scanRow, latest && styles.scanRowLatest]}>
                  <T style={styles.scanBadge}>#{confirmed.indexOf(id) + 1}</T>
                  <View style={styles.rowCopy}>
                    <T numberOfLines={1} style={styles.rowTitle}>{delivery.name}</T>
                    <T style={styles.rowMeta}>{delivery.orderNumber ?? delivery.id} · {delivery.boxes}박스</T>
                  </View>
                  <T style={styles.scanDone}>{latest ? '방금' : '✓'}</T>
                </View>
              );
            })}
            {remaining.length ? <T style={styles.section}>남은 주문 · 배송 순서</T> : null}
            {remaining.map((delivery) => (
              <View key={delivery.id} style={styles.scanRow}>
                <T style={styles.pendingBadge}>○</T>
                <View style={styles.rowCopy}>
                  <T numberOfLines={1} style={[styles.rowTitle, styles.pendingTitle]}>{delivery.name}</T>
                  <T style={styles.rowMeta}>{delivery.orderNumber ?? delivery.id} · {delivery.boxes}박스</T>
                </View>
              </View>
            ))}
          </ScrollView>
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
  camera: { flex: 45 },
  cameraBlocked: { alignItems: 'center', gap: 12, justifyContent: 'center', padding: 24 },
  blockedText: { color: colors.surface, fontSize: 16 },
  panel: { backgroundColor: colors.surface, borderTopLeftRadius: radius.card * 2, borderTopRightRadius: radius.card * 2, flex: 55, gap: 8, marginTop: -16, paddingHorizontal: 16, paddingTop: 16 },
  panelHead: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  counter: { fontSize: 34, fontWeight: '800' },
  counterTotal: { color: colors.muted, fontSize: 20, fontWeight: '700' },
  counterLabel: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  counterDone: { color: colors.green },
  notice: { borderRadius: radius.control, fontSize: 14, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 12, paddingVertical: 8 },
  noticeNote: { backgroundColor: colors.amberTint, color: colors.amber },
  noticeError: { backgroundColor: colors.errorTint, color: colors.error },
  panelList: { gap: 6, paddingBottom: 24 },
  section: { color: colors.muted, fontSize: 12, fontWeight: '700', marginTop: 6 },
  hint: { color: colors.muted, fontSize: 14, paddingVertical: 12, textAlign: 'center' },
  scanRow: { alignItems: 'center', borderColor: colors.border, borderRadius: radius.card, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 12 },
  scanRowLatest: { backgroundColor: colors.greenTint, borderColor: colors.green, borderWidth: 2 },
  scanBadge: { color: colors.green, fontSize: 15, fontWeight: '800', minWidth: 32 },
  scanDone: { color: colors.green, fontSize: 13, fontWeight: '800' },
  pendingBadge: { color: colors.done, fontSize: 18, minWidth: 32 },
  pendingTitle: { color: colors.muted },
  scanNumber: { color: colors.green, fontSize: 12, fontWeight: '800' },
});
