import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchStop, newEventId, photoUrl } from '../api/driverApi';
import type { PreviousPhoto } from '../api/driverContracts';
import type { Stop } from '../domain/dispatch';
import { MAX_QUEUED_PHOTOS, REQUIRE_COMPLETION_PHOTO } from '../domain/photoPolicy';
import { cleanCode, expectedScanItems, hasScanMismatch, matchScan, summarizeScans, type ScanResult } from '../domain/scanMatch';
import { ALLOW_COMPLETION_ON_SCAN_MISMATCH } from '../domain/scanPolicy';
import {
  buildStopEvent, draftProblem, NOTE_MAX, partialItemsFor, REASON_CODES, type PartialItem, type ReasonCode, type StopDraft,
} from '../domain/stopEvents';
import type { NewOutboxItem } from '../outbox/Outbox';
import { compressAndStore, deleteEventPhotos, deleteStoredPhoto, pickPhoto, type PhotoSource } from '../platform/photoFiles';
import { CodeScanner } from './CodeScanner';
import { Button, T } from './common';
import { PhotoStrip } from './PhotoStrip';
import { colors, radius, TOUCH_MIN } from './theme';

type Mode = 'completed' | 'failed' | 'partial';
type Stored = { localPath: string };

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'completed', label: '완료' },
  { mode: 'failed', label: '미배송' },
  { mode: 'partial', label: '부분 완료' },
];

// Reports one stop: delivered, not delivered (reason), or delivered in part (quantities), with photos and a note.
// Nothing is sent from here: the report goes to the device queue, which sends it when the network allows.
export function CompletionScreen({
  stop,
  stopId,
  date,
  vehicleId,
  queuedPhotos,
  onClose,
  onSubmit,
}: {
  stop: Stop;
  /** The server's ID of the stop (docs/api-reference.md), which events name. */
  stopId: string;
  date: string;
  vehicleId: string;
  /** Photos already waiting on the phone, for the storage warning. */
  queuedPhotos: number;
  onClose(): void;
  onSubmit(item: NewOutboxItem): Promise<void>;
}) {
  const [eventId] = useState(newEventId);
  const [mode, setMode] = useState<Mode>('completed');
  const [photos, setPhotos] = useState<Stored[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState('');
  const [reasonCode, setReasonCode] = useState<ReasonCode | null>(null);
  const baseItems = useMemo(() => partialItemsFor(stop.orders), [stop.orders]);
  const [items, setItems] = useState<PartialItem[]>(baseItems ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scans, setScans] = useState<string[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedNote, setTypedNote] = useState<string | null>(null);
  const scansRef = useRef<string[]>([]);
  const expected = useMemo(() => expectedScanItems(stop.orders), [stop.orders]);
  const summary = useMemo(() => summarizeScans(expected, scans), [expected, scans]);
  const counter = useRef(0);
  const submitted = useRef(false);
  const previous = usePreviousPhoto(date, vehicleId, stopId);

  // A report that is closed without being saved leaves no photo files behind.
  useEffect(() => () => { if (!submitted.current) deleteEventPhotos(eventId); }, [eventId]);

  async function add(source: PhotoSource) {
    setPicking(true); setPhotoError(null);
    try {
      const asset = await pickPhoto(source);
      if (!asset) return;
      const stored = await compressAndStore(asset, eventId, counter.current++);
      setPhotos((current) => [...current, { localPath: stored.localPath }]);
    } catch (cause) {
      setPhotoError(cause instanceof Error ? cause.message : '사진을 불러오지 못했습니다.');
    } finally {
      setPicking(false);
    }
  }
  function remove(index: number) {
    const target = photos[index];
    if (target) deleteStoredPhoto(target.localPath);
    setPhotos((current) => current.filter((_photo, at) => at !== index));
  }
  function step(index: number, delta: number) {
    setItems((current) => current.map((item, at) => at === index
      ? { ...item, deliveredQty: Math.min(item.orderedQty, Math.max(0, item.deliveredQty + delta)) }
      : item));
  }

  // One reading, from the camera or typed: compared with the stop's items, kept when it is new.
  function readCode(raw: string): ScanResult {
    const result = matchScan(raw, expected, scansRef.current);
    if (result.kind === 'matched' || result.kind === 'unregistered') {
      scansRef.current = [...scansRef.current, result.code];
      setScans(scansRef.current);
    }
    return result;
  }
  function addTyped() {
    const result = readCode(typed);
    setTypedNote(result.kind === 'matched' ? `일치 · ${result.items.map((item) => item.name).join(', ')}`
      : result.kind === 'duplicate' ? '이미 입력한 코드입니다.'
        : result.kind === 'unregistered' ? '이 배송지 품목에 없는 코드입니다. 목록에 기록했습니다.' : '코드를 확인해 주세요.');
    if (result.kind !== 'duplicate' && result.kind !== 'invalid') setTyped('');
  }
  function removeCode(code: string) {
    scansRef.current = scansRef.current.filter((taken) => taken !== code);
    setScans(scansRef.current);
  }

  function confirmMismatch(): Promise<boolean> {
    if (mode !== 'completed' || expected.length === 0 || !hasScanMismatch(summary)) return Promise.resolve(true);
    const lines = [
      ...summary.missing.map((item) => `읽지 못함: ${item.name}`),
      ...summary.unregistered.map((code) => `품목에 없는 코드: ${code}`),
    ].join('\n');
    if (!ALLOW_COMPLETION_ON_SCAN_MISMATCH) {
      setProblem(`상품 확인이 끝나지 않았습니다.\n${lines}`);
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      Alert.alert('상품 확인에 문제가 있습니다', `${lines}\n\n그래도 완료할까요?`, [
        { text: '돌아가기', style: 'cancel', onPress: () => resolve(false) },
        { text: '그래도 완료', onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) });
    });
  }

  async function submit() {
    if (saving) return;
    const draft: StopDraft = mode === 'completed' ? { kind: 'completed', note, scannedCodes: scans }
      : mode === 'failed' ? { kind: 'failed', reasonCode, note }
        : { kind: 'partial', items, note };
    const message = draftProblem(draft, photos.length, REQUIRE_COMPLETION_PHOTO)
      ?? (queuedPhotos + photos.length > MAX_QUEUED_PHOTOS
        ? '전송 대기 중인 사진이 너무 많습니다. 네트워크에 연결해 전송을 마친 뒤 이어서 처리해 주세요.' : null);
    if (message) { setProblem(message); return; }
    if (!(await confirmMismatch())) return;
    setSaving(true); setProblem(null);
    try {
      const { type, payload } = buildStopEvent(stopId, draft, stop.orders[0].id);
      await onSubmit({
        eventId, occurredAt: new Date().toISOString(), date, vehicleId, type, stopId, payload,
        photoPaths: photos.map((photo) => photo.localPath),
      });
      submitted.current = true;
      onClose();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : '저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  }

  const partialAllowed = baseItems !== null;
  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" disabled={saving} onPress={onClose} style={styles.headerAction}>
            <T style={styles.cancel}>취소</T>
          </Pressable>
          <View style={styles.headerCopy}>
            <T numberOfLines={1} style={styles.title}>{stop.name}</T>
            <T numberOfLines={1} style={styles.address}>{stop.address}</T>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {previous ? (
            <View style={styles.previous}>
              <T style={styles.label}>직전 완료 사진 · {previous.date}</T>
              <Image
                accessibilityLabel="직전 완료 사진"
                resizeMode="cover"
                source={{ uri: photoUrl(previous.date, previous.photoId) }}
                style={styles.previousImage}
              />
            </View>
          ) : null}

          <View accessibilityRole="tablist" style={styles.modes}>
            {MODES.map(({ mode: value, label }) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === value }}
                key={value}
                onPress={() => { setMode(value); setProblem(null); }}
                style={[styles.mode, mode === value && styles.modeSelected]}
              >
                <T style={[styles.modeText, mode === value && styles.modeTextSelected]}>{label}</T>
              </Pressable>
            ))}
          </View>

          {mode === 'failed' ? (
            <View style={styles.group}>
              <T style={styles.label}>미배송 사유</T>
              {REASON_CODES.map((reason) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: reasonCode === reason.code }}
                  key={reason.code}
                  onPress={() => setReasonCode(reason.code)}
                  style={[styles.reason, reasonCode === reason.code && styles.reasonSelected]}
                >
                  <T style={styles.reasonMark}>{reasonCode === reason.code ? '●' : '○'}</T>
                  <T style={styles.reasonText}>{reason.label}</T>
                </Pressable>
              ))}
            </View>
          ) : null}

          {mode === 'partial' ? (
            <View style={styles.group}>
              <T style={styles.label}>품목별 배송 수량</T>
              {partialAllowed ? items.map((item, index) => (
                <View key={item.sku} style={styles.item}>
                  <View style={styles.itemCopy}>
                    <T numberOfLines={2} style={styles.itemName}>{item.name}</T>
                    <T style={styles.itemMeta}>주문 {item.orderedQty}</T>
                  </View>
                  <Pressable accessibilityLabel={`${item.name} 수량 줄이기`} accessibilityRole="button" onPress={() => step(index, -1)} style={styles.step}>
                    <T style={styles.stepText}>−</T>
                  </Pressable>
                  <T style={styles.qty}>{item.deliveredQty}</T>
                  <Pressable accessibilityLabel={`${item.name} 수량 늘리기`} accessibilityRole="button" onPress={() => step(index, 1)} style={styles.step}>
                    <T style={styles.stepText}>+</T>
                  </Pressable>
                </View>
              )) : (
                <T style={styles.hint}>
                  {stop.orders.length > 1
                    ? '주문이 여러 건인 배송지는 부분 완료를 지원하지 않습니다. 완료 또는 미배송으로 처리해 주세요.'
                    : '품목 정보가 없어 부분 완료를 처리할 수 없습니다.'}
                </T>
              )}
            </View>
          ) : null}

          {mode === 'completed' && expected.length > 0 ? (
            <View style={styles.group}>
              <T style={styles.label}>상품 확인 (선택) · {summary.items.filter((item) => item.read).length}/{summary.items.length}</T>
              {summary.items.map((item) => (
                <T key={`${item.orderId}:${item.sku}`} style={item.read ? styles.itemRead : styles.itemUnread}>
                  {item.read ? '✓' : '○'} {item.name}
                </T>
              ))}
              {summary.unregistered.map((code) => (
                <View key={code} style={styles.codeRow}>
                  <T style={styles.itemBad}>품목에 없는 코드 {code}</T>
                  <Pressable accessibilityLabel={`코드 ${code} 지우기`} accessibilityRole="button" onPress={() => removeCode(code)} style={styles.step}>
                    <T style={styles.stepText}>×</T>
                  </Pressable>
                </View>
              ))}
              <Button label="카메라로 스캔" onPress={() => setScannerOpen(true)} tone="secondary" />
              <View style={styles.codeRow}>
                <TextInput
                  accessibilityLabel="코드 직접 입력"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={128}
                  onChangeText={(value) => { setTyped(value); setTypedNote(null); }}
                  onSubmitEditing={addTyped}
                  placeholder="코드 직접 입력"
                  placeholderTextColor={colors.muted}
                  style={[styles.note, styles.codeInput]}
                  value={typed}
                />
                <Button disabled={!cleanCode(typed)} label="추가" onPress={addTyped} style={styles.addCode} tone="secondary" />
              </View>
              {typedNote ? <T style={styles.hint}>{typedNote}</T> : null}
            </View>
          ) : null}

          <PhotoStrip busy={picking} error={photoError} onAdd={(source) => void add(source)} onRemove={remove} uris={photos.map((photo) => photo.localPath)} />

          <View style={styles.group}>
            <T style={styles.label}>특이사항 (선택)</T>
            <TextInput
              accessibilityLabel="특이사항"
              maxLength={NOTE_MAX}
              multiline
              onChangeText={setNote}
              placeholder="문 앞 보관, 인수자 등"
              placeholderTextColor={colors.muted}
              style={styles.note}
              value={note}
            />
            <T style={styles.hint}>{note.length}/{NOTE_MAX}</T>
          </View>
        </ScrollView>
        <View style={styles.footer}>
          {problem ? <T accessibilityRole="alert" style={styles.problem}>{problem}</T> : null}
          <Button
            busy={saving}
            disabled={mode === 'partial' && !partialAllowed}
            label={mode === 'completed' ? '완료 처리' : mode === 'failed' ? '미배송 처리' : '부분 완료 처리'}
            onPress={() => void submit()}
          />
        </View>
      </SafeAreaView>
      {scannerOpen ? (
        <CodeScanner
          onClose={() => setScannerOpen(false)}
          onScan={readCode}
          readCount={summary.items.filter((item) => item.read).length}
          total={summary.items.length}
        />
      ) : null}
    </Modal>
  );
}

// Best effort: offline or a stop without an earlier photo simply shows nothing.
function usePreviousPhoto(date: string, vehicleId: string, stopId: string): PreviousPhoto | null {
  const [previous, setPrevious] = useState<PreviousPhoto | null>(null);
  useEffect(() => {
    let live = true;
    fetchStop(date, vehicleId, stopId).then((detail) => { if (live) setPrevious(detail.previousPhoto); }).catch(() => undefined);
    return () => { live = false; };
  }, [date, vehicleId, stopId]);
  return previous;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  header: { alignItems: 'center', backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: 'row', gap: 8, padding: 12 },
  headerAction: { justifyContent: 'center', minHeight: TOUCH_MIN, paddingHorizontal: 8 },
  cancel: { color: colors.action, fontSize: 16, fontWeight: '700' },
  headerCopy: { flex: 1, gap: 2 },
  title: { fontSize: 17, fontWeight: '800' },
  address: { color: colors.muted, fontSize: 13 },
  body: { gap: 16, padding: 12, paddingBottom: 24 },
  previous: { gap: 6 },
  previousImage: { backgroundColor: colors.border, borderRadius: radius.card, height: 140, width: '100%' },
  modes: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: 1, flexDirection: 'row', overflow: 'hidden' },
  mode: { alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: TOUCH_MIN + 4 },
  modeSelected: { backgroundColor: colors.brand },
  modeText: { fontSize: 15, fontWeight: '700' },
  modeTextSelected: { color: colors.surface },
  group: { gap: 8 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  reason: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: TOUCH_MIN + 4, paddingHorizontal: 12 },
  reasonSelected: { borderColor: colors.brand },
  reasonMark: { color: colors.brand, fontSize: 16 },
  reasonText: { fontSize: 16 },
  item: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: 1, flexDirection: 'row', gap: 8, padding: 10 },
  itemCopy: { flex: 1, gap: 2 },
  itemName: { fontSize: 15, fontWeight: '700' },
  itemMeta: { color: colors.muted, fontSize: 12 },
  step: { alignItems: 'center', backgroundColor: colors.background, borderRadius: radius.control, height: TOUCH_MIN, justifyContent: 'center', width: TOUCH_MIN },
  stepText: { fontSize: 20, fontWeight: '800' },
  qty: { fontSize: 17, fontWeight: '800', minWidth: 28, textAlign: 'center' },
  note: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: 1, fontSize: 16, minHeight: 80, padding: 12, textAlignVertical: 'top' },
  hint: { color: colors.muted, fontSize: 12 },
  footer: { backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1, gap: 8, padding: 12 },
  problem: { color: colors.error, fontSize: 14 },
  itemRead: { color: colors.green, fontSize: 15 },
  itemUnread: { color: colors.muted, fontSize: 15 },
  itemBad: { color: colors.error, flex: 1, fontSize: 14 },
  codeRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  codeInput: { flex: 1, minHeight: TOUCH_MIN + 4 },
  addCode: { minWidth: 72 },
});
