import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { Stop } from '../domain/dispatch';
import {
  createDeliveryOrderPositions,
  moveDeliveryOrderPosition,
  resolveDeliveryOrderDragTarget,
  type DeliveryOrderPositions,
} from '../domain/delivery/sortableOrder';
import { Button, SequenceBadge, T } from './common';
import { colors, radius, TOUCH_MIN } from './theme';

const ROW_BASE_HEIGHT = 84;
const ROW_GAP = 6;
const LIST_PADDING_TOP = 8;
const LIST_PADDING_BOTTOM = 18;
const NEIGHBOR_MOVE_DURATION_MS = 170;
const DRAG_SETTLE_DURATION_MS = 140;
const DRAG_ACTIVATION_DISTANCE = 2;

// Drag editor for pending stops only. A stop moves with all of its orders.
export function RouteOrderEditor({
  stops,
  isSaving,
  onCancel,
  onSave,
  onSuggest,
}: {
  stops: Stop[];
  isSaving: boolean;
  onCancel(): void;
  onSave(stopKeys: string[]): void;
  onSuggest(): Promise<{ keys: string[]; summary: string }>;
}) {
  const { fontScale } = useWindowDimensions();
  const [ordered, setOrdered] = useState(stops);
  const [suggesting, setSuggesting] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const rowHeight = Math.round(ROW_BASE_HEIGHT * Math.max(1, fontScale));
  const rowStep = rowHeight + ROW_GAP;
  const positions = useSharedValue(createDeliveryOrderPositions(stops.map((stop) => stop.key)));
  const activeKey = useSharedValue<string | null>(null);
  const listHeight = LIST_PADDING_TOP + Math.max(0, ordered.length * rowStep - ROW_GAP) + LIST_PADDING_BOTTOM;

  useEffect(() => {
    positions.set(createDeliveryOrderPositions(ordered.map((stop) => stop.key)));
  }, [ordered, positions]);

  function onDrop(stopKey: string, targetIndex: number) {
    setOrdered((current) => {
      const from = current.findIndex((stop) => stop.key === stopKey);
      if (from < 0 || targetIndex < 0 || targetIndex >= current.length || from === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  async function suggest() {
    setSuggesting(true);
    setNote(null);
    try {
      const { keys, summary } = await onSuggest();
      const byKey = new Map(stops.map((stop) => [stop.key, stop]));
      setOrdered(keys.map((key) => byKey.get(key)).filter((stop): stop is Stop => !!stop));
      setNote({ text: `${summary}. 확인하고 완료를 누르면 적용됩니다.`, error: false });
    } catch (cause) {
      setNote({ text: cause instanceof Error ? cause.message : '자동 순서를 만들지 못했습니다.', error: true });
    } finally {
      setSuggesting(false);
    }
  }

  const changed = ordered.some((stop, index) => stop.key !== stops[index]?.key);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" disabled={isSaving} onPress={onCancel} style={styles.headerAction}>
          <T style={styles.cancelText}>취소</T>
        </Pressable>
        <View style={styles.headingCopy}>
          <T style={styles.title}>순서 편집</T>
          <T style={styles.description}>대기 중인 배송지만 이동합니다</T>
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={isSaving || !changed}
          onPress={() => onSave(ordered.map((stop) => stop.key))}
          style={styles.headerAction}
        >
          <T style={[styles.doneText, (!changed || isSaving) && styles.disabledText]}>
            {isSaving ? '저장 중…' : '완료'}
          </T>
        </Pressable>
      </View>
      <View style={styles.suggest}>
        <Button busy={suggesting} disabled={isSaving} label="자동 생성" onPress={() => void suggest()} tone="secondary" />
        {note ? <T accessibilityRole={note.error ? 'alert' : undefined} style={note.error ? styles.noteError : styles.note}>{note.text}</T> : null}
      </View>
      <ScrollView pointerEvents={isSaving ? 'none' : 'auto'} removeClippedSubviews={false} style={styles.scroll}>
        <View style={[styles.list, { height: listHeight }]}>
          {ordered.map((stop, index) => (
            <DraggableStopRow
              activeKey={activeKey}
              index={index}
              key={stop.key}
              onDrop={onDrop}
              positions={positions}
              rowCount={ordered.length}
              rowHeight={rowHeight}
              rowStep={rowStep}
              stop={stop}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function DraggableStopRow({
  activeKey,
  index,
  onDrop,
  positions,
  rowCount,
  rowHeight,
  rowStep,
  stop,
}: {
  activeKey: SharedValue<string | null>;
  index: number;
  onDrop(stopKey: string, targetIndex: number): void;
  positions: SharedValue<DeliveryOrderPositions>;
  rowCount: number;
  rowHeight: number;
  rowStep: number;
  stop: Stop;
}) {
  const rowTop = useSharedValue(index * rowStep);
  const dragStartTop = useSharedValue(index * rowStep);
  const startPositions = useSharedValue<DeliveryOrderPositions>({});

  useAnimatedReaction(
    () => {
      const nextIndex = positions.get()[stop.key];
      return nextIndex === undefined ? null : nextIndex * rowStep;
    },
    (nextTop, previousTop) => {
      if (nextTop === null || nextTop === previousTop || activeKey.get() === stop.key) return;
      rowTop.set(withTiming(nextTop, { duration: NEIGHBOR_MOVE_DURATION_MS, easing: Easing.out(Easing.cubic) }));
    },
    [stop.key, rowStep],
  );

  const settle = (top: number) => {
    'worklet';
    rowTop.set(withTiming(top, { duration: DRAG_SETTLE_DURATION_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
      if (finished && activeKey.get() === stop.key) activeKey.set(null);
    }));
  };

  const dragGesture = Gesture.Pan()
    .minDistance(DRAG_ACTIVATION_DISTANCE)
    .onStart(() => {
      cancelAnimation(rowTop);
      dragStartTop.set(rowTop.get());
      startPositions.set(positions.get());
      activeKey.set(stop.key);
    })
    .onUpdate((event) => {
      const maxTop = Math.max(0, (rowCount - 1) * rowStep);
      const nextTop = Math.max(0, Math.min(maxTop, dragStartTop.get() + event.translationY));
      const currentIndex = positions.get()[stop.key] ?? index;
      const targetIndex = resolveDeliveryOrderDragTarget({ absoluteTop: nextTop, currentIndex, rowCount, rowStep });
      rowTop.set(nextTop);
      if (targetIndex !== currentIndex) {
        positions.set(moveDeliveryOrderPosition(positions.get(), stop.key, targetIndex));
      }
    })
    .onEnd(() => {
      const targetIndex = positions.get()[stop.key] ?? index;
      settle(targetIndex * rowStep);
      scheduleOnRN(onDrop, stop.key, targetIndex);
    })
    .onFinalize((_event, success) => {
      if (success || activeKey.get() !== stop.key) return;
      positions.set(startPositions.get());
      settle((startPositions.get()[stop.key] ?? index) * rowStep);
    });

  const animatedStyle = useAnimatedStyle(() => {
    const isActive = activeKey.get() === stop.key;
    return {
      borderColor: isActive ? colors.brand : colors.border,
      elevation: isActive ? 6 : 0,
      transform: [{ translateY: rowTop.get() }],
      zIndex: isActive ? 10 : 1,
    };
  }, [stop.key]);

  return (
    <Animated.View style={[styles.card, { height: rowHeight }, animatedStyle]}>
      <GestureDetector gesture={dragGesture}>
        <View
          accessibilityHint="누른 채 위아래로 이동해 배송지 순서를 바꿉니다."
          accessibilityLabel={`${stop.name} 순서 이동 핸들`}
          accessibilityRole="button"
          style={styles.handle}
        >
          <T style={styles.handleIcon}>≡</T>
        </View>
      </GestureDetector>
      <SequenceBadge tone="pending" value={index + 1} />
      <View style={styles.copy}>
        <T numberOfLines={1} style={styles.name}>{stop.name}</T>
        <T numberOfLines={2} style={styles.address}>{stop.address}</T>
        <T style={styles.meta}>주문 {stop.orders.length}건 · {stop.boxes}박스</T>
      </View>
      <View style={styles.moveButtons}>
        {([-1, 1] as const).map((direction) => {
          const disabled = index + direction < 0 || index + direction >= rowCount;
          return (
            <Pressable
              accessibilityLabel={`${stop.name} ${direction < 0 ? '위로' : '아래로'} 이동`}
              accessibilityRole="button"
              disabled={disabled}
              key={direction}
              onPress={() => {
                if (activeKey.get() === null) onDrop(stop.key, index + direction);
              }}
              style={[styles.moveButton, disabled && styles.moveDisabled]}
            >
              <T style={styles.moveText}>{direction < 0 ? '↑' : '↓'}</T>
            </Pressable>
          );
        })}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  suggest: { gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  note: { color: colors.muted, fontSize: 13 },
  noteError: { color: colors.error, fontSize: 13 },
  header: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    minHeight: 60,
    paddingHorizontal: 8,
  },
  headerAction: { alignItems: 'center', justifyContent: 'center', minHeight: TOUCH_MIN, minWidth: 64 },
  headingCopy: { alignItems: 'center', flex: 1 },
  title: { fontSize: 17, fontWeight: '800' },
  description: { color: colors.muted, fontSize: 12 },
  cancelText: { color: colors.muted, fontSize: 16, fontWeight: '700' },
  doneText: { color: colors.brand, fontSize: 16, fontWeight: '800' },
  disabledText: { opacity: 0.4 },
  scroll: { flex: 1 },
  list: { position: 'relative' },
  card: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    left: 12,
    paddingRight: 4,
    position: 'absolute',
    right: 12,
    top: LIST_PADDING_TOP,
  },
  handle: { alignItems: 'center', alignSelf: 'stretch', justifyContent: 'center', width: 44 },
  handleIcon: { color: colors.muted, fontSize: 24 },
  copy: { flex: 1, gap: 1, paddingLeft: 4 },
  name: { fontSize: 15, fontWeight: '700' },
  address: { color: colors.muted, fontSize: 12 },
  meta: { color: colors.action, fontSize: 12, fontWeight: '600' },
  moveButtons: { flexDirection: 'row' },
  moveButton: { alignItems: 'center', justifyContent: 'center', minHeight: TOUCH_MIN, minWidth: TOUCH_MIN },
  moveDisabled: { opacity: 0.25 },
  moveText: { color: colors.action, fontSize: 20, fontWeight: '800' },
});
