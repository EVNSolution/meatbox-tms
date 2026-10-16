import { useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, TextInput, View } from 'react-native';

import { fetchStop, newEventId, photoUrl, saveTip } from '../api/driverApi';
import type { StopDetail } from '../api/driverContracts';
import { ApiError } from '../api/types';
import { RetryAttempt } from '../domain/retryAttempt';
import { detailSections, tipBody } from '../domain/routeView';
import { TIP_MAX, tipProblem } from '../domain/tip';
import { Button, T } from './common';
import { colors, radius } from './theme';

type Loaded = { status: 'idle' } | { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; detail: StopDetail };

function tipFailure(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 409) return '이미 끝난 배송지의 팁은 바꿀 수 없습니다.';
  if (cause instanceof ApiError && cause.status === 400) return '팁 내용을 확인해 주세요. (500자 이하, <·> 사용 불가, 바뀐 내용 필요)';
  if (cause instanceof ApiError && cause.status === 404) return '이 배송지를 찾을 수 없습니다.';
  return '팁을 저장하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
}

// Customer requests, tip, access, items and the last completion photo of one stop, read when the driver asks.
// A stop that is not closed also lets the driver write the tip for the next visit.
export function StopInfo({
  date,
  vehicleId,
  stopId,
  tipEditable,
  onTipSaved,
}: {
  date: string;
  vehicleId: string;
  stopId: string;
  tipEditable: boolean;
  onTipSaved(): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'idle' });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tipError, setTipError] = useState<string | null>(null);
  const attempts = useRef(new RetryAttempt<string>());

  async function open() {
    setLoaded({ status: 'loading' });
    try {
      setLoaded({ status: 'ready', detail: await fetchStop(date, vehicleId, stopId) });
    } catch (cause) {
      const missing = cause instanceof ApiError && cause.status === 404;
      setLoaded({ status: 'error', text: missing ? '이 배송지를 찾을 수 없습니다.' : '상세 정보를 불러오지 못했습니다.' });
    }
  }

  async function submitTip(current: string) {
    if (draft === null || saving) return;
    const problem = tipProblem(draft, current);
    if (problem) { setTipError(problem); return; }
    setSaving(true); setTipError(null);
    try {
      // A resend after a lost answer carries the same request ID, so the server answers from its stored result.
      const requestId = await attempts.current.get(draft, newEventId);
      await saveTip(date, vehicleId, stopId, requestId, draft);
      attempts.current.settle();
      setDraft(null);
      onTipSaved();
      await open();
    } catch (cause) {
      if (cause instanceof ApiError) attempts.current.settle();
      setTipError(tipFailure(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loaded.status === 'idle') return <Button label="상세 보기" onPress={() => void open()} tone="secondary" />;
  if (loaded.status === 'loading') return <ActivityIndicator color={colors.brand} />;
  if (loaded.status === 'error') {
    return <View style={styles.wrap}><T accessibilityRole="alert" style={styles.error}>{loaded.text}</T>
      <Button label="다시 시도" onPress={() => void open()} tone="secondary" /></View>;
  }
  const sections = detailSections(loaded.detail);
  const previous = loaded.detail.previousPhoto;
  const current = tipBody(loaded.detail);
  return (
    <View style={styles.wrap}>
      {sections.length === 0 && !previous && !tipEditable ? <T style={styles.muted}>추가 정보가 없습니다.</T> : null}
      {sections.map((section) => (
        <View key={section.title} style={styles.section}>
          <T style={styles.title}>{section.title}</T>
          {section.lines.map((line) => <T key={line} style={styles.line}>{line}</T>)}
        </View>
      ))}
      {tipEditable && draft === null ? (
        <Button label={current ? '배송팁 수정' : '배송팁 쓰기'} onPress={() => { setDraft(current); setTipError(null); }} tone="secondary" />
      ) : null}
      {draft !== null ? (
        <View style={styles.section}>
          <T style={styles.title}>배송팁 (다음 방문자에게 보입니다)</T>
          <TextInput
            accessibilityLabel="배송팁"
            editable={!saving}
            maxLength={TIP_MAX}
            multiline
            onChangeText={setDraft}
            placeholder="출입 방법, 주차 위치 등"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={draft}
          />
          <T style={styles.muted}>{draft.length}/{TIP_MAX}</T>
          {tipError ? <T accessibilityRole="alert" style={styles.error}>{tipError}</T> : null}
          <View style={styles.actions}>
            <Button disabled={saving} label="취소" onPress={() => { setDraft(null); setTipError(null); }} style={styles.action} tone="secondary" />
            <Button busy={saving} label="저장" onPress={() => void submitTip(current)} style={styles.action} />
          </View>
        </View>
      ) : null}
      {previous ? (
        <View style={styles.section}>
          <T style={styles.title}>직전 완료 사진 · {previous.date}</T>
          <Image
            accessibilityLabel="직전 완료 사진"
            resizeMode="cover"
            source={{ uri: photoUrl(previous.date, previous.photoId) }}
            style={styles.photo}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopColor: colors.border, borderTopWidth: 1, gap: 10, paddingTop: 10 },
  section: { gap: 3 },
  title: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  line: { fontSize: 15 },
  muted: { color: colors.muted, fontSize: 12 },
  error: { color: colors.error, fontSize: 14 },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: 1, fontSize: 16, minHeight: 80, padding: 12, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  action: { flex: 1 },
  photo: { backgroundColor: colors.border, borderRadius: radius.card, height: 180, width: '100%' },
});
