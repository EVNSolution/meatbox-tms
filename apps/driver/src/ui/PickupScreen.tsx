import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
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
  starting,
  onStart,
  onEditOrder,
}: {
  date: string;
  vehicleId: string;
  deliveries: FleetDelivery[];
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
    const result = matchPickupQr({ raw, date, vehicleOrderIds, scanned: scanRef.current });
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

// Scanning is never throttled: several QR codes in view are all accepted. A bottom sheet keeps the
// result legible: collapsed it shows only the count, dragged up it lists remaining then confirmed orders.
const SHEET_PEEK = 58;
const SHEET_SPRING = { damping: 24, stiffness: 240, mass: 0.9 } as const;
const COMPLETE_CLOSE_MS = 2000;
const NOTICE_MS = 2500;

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
  const [expired, setExpired] = useState<Feedback | null>(null);
  const notice = feedback && feedback.tone !== 'ok' && feedback !== expired ? feedback : null;
  const byId = useMemo(() => new Map(deliveries.map((d) => [d.id, d])), [deliveries]);
  const confirmed = [...scanned].filter((id) => byId.has(id));
  const remaining = deliveries.filter((d) => !scanned.has(d.id));
  const complete = deliveries.length > 0 && remaining.length === 0;

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    if (!feedback || feedback.tone === 'ok') return;
    const timer = setTimeout(() => setExpired(feedback), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  // The parent passes a new onClose on every render; keep the 2-second close from being postponed.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!complete) return;
    const timer = setTimeout(() => closeRef.current(), COMPLETE_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [complete]);

  function onBarcodeScanned(result: BarcodeScanningResult) {
    const now = Date.now();
    // The camera reports the same code many times per second.
    if (last.current && last.current.raw === result.data && now - last.current.at < 2500) return;
    last.current = { raw: result.data, at: now };
    onScan(result.data);
  }

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <GestureHandlerRootView style={styles.scanner}>
        <SafeAreaView style={styles.scanner}>
          <View style={styles.scannerHeader}>
            <T style={styles.scannerTitle}>수령 QR 스캔</T>
            <Button label="닫기" onPress={onClose} style={styles.closeButton} tone="secondary" />
          </View>
          <View style={styles.stage}>
            {permission?.granted ? (
              <CameraView
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                facing="back"
                onBarcodeScanned={complete ? undefined : onBarcodeScanned}
                style={StyleSheet.absoluteFill}
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.cameraBlocked]}>
                <T style={styles.blockedText}>카메라 권한이 필요합니다.</T>
                <Button label="권한 허용" onPress={() => void requestPermission()} tone="action" />
              </View>
            )}
            {notice && !complete ? (
              <View pointerEvents="none" style={styles.noticeWrap}>
                <T style={[styles.notice, notice.tone === 'error' ? styles.noticeError : styles.noticeNote]}>{notice.text}</T>
              </View>
            ) : null}
            {complete ? (
              <View pointerEvents="none" style={styles.completeWrap}>
                <View style={styles.complete}>
                  <T style={styles.completeMark}>✓</T>
                  <T style={styles.completeTitle}>완료되었습니다</T>
                  <T style={styles.completeCount}>{confirmed.length} / {deliveries.length}</T>
                </View>
              </View>
            ) : null}
            <ScanSheet
              header={
                <View style={styles.sheetHead}>
                  <T style={[styles.counter, complete && styles.counterDone]}>
                    {confirmed.length}<T style={[styles.counterTotal, complete && styles.counterDone]}> / {deliveries.length}</T>
                  </T>
                  <T style={[styles.counterLabel, complete && styles.counterDone]}>{complete ? '모두 확인됨' : `남은 주문 ${remaining.length}`}</T>
                </View>
              }
            >
              {remaining.length ? <T style={styles.section}>남은 주문</T> : null}
              {remaining.map((delivery, index) => (
                <ScanRow
                  box={`${delivery.boxes}박스`}
                  key={delivery.id}
                  label={String(delivery.sequence)}
                  name={delivery.name}
                  tail={tail(delivery)}
                  tone="pending"
                />
              ))}
              {confirmed.length ? <T style={styles.section}>성공한 주문</T> : null}
              {confirmed.map((id, index) => {
                const delivery = byId.get(id)!;
                const latest = id === latestId;
                return (
                  <ScanRow
                    box={latest ? '방금' : `${delivery.boxes}박스`}
                    key={id}
                    label={`#${index + 1}`}
                    name={delivery.name}
                    tail={tail(delivery)}
                    tone={latest ? 'latest' : 'done'}
                  />
                );
              })}
            </ScanSheet>
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    </Modal>
  );
}

// Last four characters of the order number tell apart several orders for the same store.
function tail(delivery: FleetDelivery): string {
  return String(delivery.orderNumber ?? delivery.id).slice(-4);
}

function ScanRow({ label, name, tail: suffix, box, tone }: { label: string; name: string; tail: string; box: string; tone: 'pending' | 'done' | 'latest' }) {
  const pending = tone === 'pending';
  return (
    <View style={[styles.scanRow, tone === 'latest' && styles.scanRowLatest]}>
      <T style={[styles.scanKey, pending ? styles.muted : styles.green]}>{label}</T>
      <T numberOfLines={1} style={[styles.scanName, pending && styles.mutedText, tone === 'latest' && styles.bold]}>{name}</T>
      <T style={styles.scanTail}>{suffix}</T>
      <T style={[styles.scanBox, tone === 'latest' && styles.greenBold]}>{box}</T>
    </View>
  );
}

// Bottom sheet that rests showing only its header and expands when dragged up or tapped.
function ScanSheet({ header, children }: { header: ReactNode; children: ReactNode }) {
  const [stage, setStage] = useState(0);
  const expanded = Math.round(stage * 0.8);
  const collapsed = Math.max(0, expanded - SHEET_PEEK);
  const y = useSharedValue(0);
  const start = useSharedValue(0);

  useEffect(() => {
    if (stage) y.set(collapsed);
  }, [collapsed, stage, y]);

  const pan = Gesture.Pan()
    .onBegin(() => {
      start.set(y.get());
    })
    .onUpdate((event) => {
      y.set(Math.min(collapsed, Math.max(0, start.get() + event.translationY)));
    })
    .onEnd((event) => {
      const open = event.velocityY < -500 || (event.velocityY < 500 && y.get() < collapsed / 2);
      y.set(withSpring(open ? 0 : collapsed, SHEET_SPRING));
    });
  const tap = Gesture.Tap().onEnd(() => {
    y.set(withSpring(y.get() > collapsed / 2 ? 0 : collapsed, SHEET_SPRING));
  });

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));

  return (
    <>
      <View onLayout={(event) => setStage(event.nativeEvent.layout.height)} pointerEvents="none" style={StyleSheet.absoluteFill} />
      {stage ? (
        <Animated.View style={[styles.sheet, { height: expanded }, animatedStyle]}>
          <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
            <View accessibilityHint="끌어올리면 주문 목록이 보입니다" style={styles.sheetGrab}>
              <View style={styles.grabber} />
              {header}
            </View>
          </GestureDetector>
          <ScrollView contentContainerStyle={styles.sheetList}>{children}</ScrollView>
        </Animated.View>
      ) : null}
    </>
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
  stage: { flex: 1, overflow: 'hidden' },
  cameraBlocked: { alignItems: 'center', gap: 12, justifyContent: 'center', padding: 24 },
  blockedText: { color: colors.surface, fontSize: 16 },
  noticeWrap: { alignItems: 'center', bottom: SHEET_PEEK + 16, left: 16, position: 'absolute', right: 16 },
  notice: { borderRadius: 18, fontSize: 14, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 14, paddingVertical: 8 },
  noticeNote: { backgroundColor: colors.amberTint, color: colors.amber },
  noticeError: { backgroundColor: colors.errorTint, color: colors.error },
  completeWrap: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0, alignItems: 'center', justifyContent: 'center', paddingBottom: SHEET_PEEK },
  complete: { alignItems: 'center', backgroundColor: colors.overlay, borderRadius: 16, gap: 2, paddingHorizontal: 32, paddingVertical: 20 },
  completeMark: { color: colors.greenOnDark, fontSize: 36, fontWeight: '800' },
  completeTitle: { color: colors.surface, fontSize: 20, fontWeight: '800' },
  completeCount: { color: colors.surface, fontSize: 14, opacity: 0.75 },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, bottom: 0, left: 0, position: 'absolute', right: 0 },
  sheetGrab: { height: SHEET_PEEK, paddingHorizontal: 10, paddingTop: 6 },
  grabber: { alignSelf: 'center', backgroundColor: colors.done, borderRadius: 2, height: 4, marginBottom: 6, width: 36 },
  sheetHead: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  counter: { fontSize: 24, fontWeight: '800' },
  counterTotal: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  counterLabel: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  counterDone: { color: colors.green },
  sheetList: { paddingBottom: 16, paddingHorizontal: 8 },
  section: { color: colors.muted, fontSize: 12, fontWeight: '700', marginBottom: 2, marginTop: 8 },
  scanRow: { alignItems: 'center', borderBottomColor: colors.background, borderBottomWidth: 1, flexDirection: 'row', gap: 4, height: 30 },
  scanRowLatest: { backgroundColor: colors.greenTint, marginHorizontal: -8, paddingHorizontal: 8 },
  scanKey: { fontSize: 13, fontWeight: '800', minWidth: 22, textAlign: 'right' },
  scanName: { flex: 1, fontSize: 14 },
  scanTail: { color: colors.done, fontSize: 12 },
  scanBox: { color: colors.muted, fontSize: 13, minWidth: 34, textAlign: 'right' },
  muted: { color: colors.done },
  mutedText: { color: colors.muted },
  green: { color: colors.green },
  greenBold: { color: colors.green, fontWeight: '800' },
  bold: { fontWeight: '800' },
  scanNumber: { color: colors.green, fontSize: 12, fontWeight: '800' },
});
