import { Alert, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { outboxKindLabel, outboxStatusText } from '../domain/outboxView';
import type { OutboxItem } from '../outbox/Outbox';
import { Button, T } from './common';
import { colors, radius } from './theme';

// The reports still on the phone, in the order they will be sent, with what stopped them and what can be done.
export function OutboxSheet({
  items,
  labelFor,
  onRetry,
  onDiscard,
  onClose,
}: {
  items: readonly OutboxItem[];
  labelFor(item: OutboxItem): string;
  onRetry(eventId: string): void;
  onDiscard(eventId: string): void;
  onClose(): void;
}) {
  const open = items.filter((item) => item.state !== 'sent');
  function confirmDiscard(item: OutboxItem) {
    Alert.alert(
      '보내지 않고 삭제할까요?',
      `${labelFor(item)}의 ${outboxKindLabel(item.type)} 기록과 사진이 이 기기에서 지워집니다. 서버에는 반영되지 않습니다.`,
      [{ text: '취소', style: 'cancel' }, { text: '삭제', style: 'destructive', onPress: () => onDiscard(item.eventId) }],
    );
  }
  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <T style={styles.title}>전송 대기 {open.length}건</T>
          <Button label="닫기" onPress={onClose} tone="secondary" />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {open.length === 0 ? <T style={styles.muted}>전송을 기다리는 기록이 없습니다.</T> : null}
          {open.map((item) => (
            <View key={item.eventId} style={[styles.card, item.state === 'rejected' && styles.cardRejected]}>
              <T style={styles.name}>{labelFor(item)} · {outboxKindLabel(item.type)}</T>
              <T style={styles.meta}>사진 {item.photos.length}장 · {new Date(item.occurredAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })}</T>
              <T style={item.state === 'rejected' ? styles.rejected : styles.status}>{outboxStatusText(item)}</T>
              <View style={styles.actions}>
                {item.state !== 'uploading' ? <Button label={item.state === 'rejected' ? '다시 시도' : '지금 보내기'} onPress={() => onRetry(item.eventId)} style={styles.action} tone="secondary" /> : null}
                <Button label="삭제" onPress={() => confirmDiscard(item)} style={styles.action} tone="danger" />
              </View>
            </View>
          ))}
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
  muted: { color: colors.muted, fontSize: 14 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.card, borderWidth: 1, gap: 4, padding: 12 },
  cardRejected: { borderColor: colors.error },
  name: { fontSize: 16, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 13 },
  status: { color: colors.action, fontSize: 14 },
  rejected: { color: colors.error, fontSize: 14 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  action: { flex: 1 },
});
