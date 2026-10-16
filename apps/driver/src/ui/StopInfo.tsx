import { useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';

import { fetchStop, photoUrl } from '../api/driverApi';
import type { StopDetail } from '../api/driverContracts';
import { ApiError } from '../api/types';
import { detailSections } from '../domain/routeView';
import { Button, T } from './common';
import { colors, radius } from './theme';

type Loaded = { status: 'idle' } | { status: 'loading' } | { status: 'error'; text: string } | { status: 'ready'; detail: StopDetail };

// Customer requests, tip, access, items and the last completion photo of one stop, read when the driver asks.
export function StopInfo({ date, vehicleId, stopId }: { date: string; vehicleId: string; stopId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'idle' });

  async function open() {
    setLoaded({ status: 'loading' });
    try {
      setLoaded({ status: 'ready', detail: await fetchStop(date, vehicleId, stopId) });
    } catch (cause) {
      const missing = cause instanceof ApiError && cause.status === 404;
      setLoaded({ status: 'error', text: missing ? '이 배송지를 찾을 수 없습니다.' : '상세 정보를 불러오지 못했습니다.' });
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
  return (
    <View style={styles.wrap}>
      {sections.length === 0 && !previous ? <T style={styles.muted}>추가 정보가 없습니다.</T> : null}
      {sections.map((section) => (
        <View key={section.title} style={styles.section}>
          <T style={styles.title}>{section.title}</T>
          {section.lines.map((line) => <T key={line} style={styles.line}>{line}</T>)}
        </View>
      ))}
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
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.error, fontSize: 14 },
  photo: { backgroundColor: colors.border, borderRadius: radius.card, height: 180, width: '100%' },
});
