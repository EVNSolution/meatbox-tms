import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { colors } from './theme';

const SPRING = { damping: 22, stiffness: 220, mass: 0.9 } as const;

// Slide-up sheet anchored to the bottom of its parent. Drag down or set open=false to dismiss.
export function BottomSheet({
  open,
  onDismiss,
  children,
}: {
  open: boolean;
  onDismiss(): void;
  children: ReactNode;
}) {
  const [height, setHeight] = useState(600);
  const translateY = useSharedValue(height);

  useEffect(() => {
    translateY.set(open ? withSpring(0, SPRING) : withTiming(height, { duration: 180 }));
  }, [height, open, translateY]);

  const drag = Gesture.Pan()
    .onUpdate((event) => {
      translateY.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (event.translationY > height * 0.28 || event.velocityY > 900) {
        translateY.set(withTiming(height, { duration: 160 }));
        scheduleOnRN(onDismiss);
      } else {
        translateY.set(withSpring(0, SPRING));
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.get() }] }));

  return (
    <Animated.View
      onLayout={(event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height + 24)}
      pointerEvents={open ? 'auto' : 'none'}
      style={[styles.sheet, animatedStyle]}
    >
      <GestureDetector gesture={drag}>
        <View accessibilityLabel="아래로 끌어서 닫기" style={styles.grabArea}>
          <View style={styles.grabber} />
        </View>
      </GestureDetector>
      <View style={styles.content}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    bottom: 0,
    elevation: 12,
    left: 0,
    position: 'absolute',
    right: 0,
    shadowColor: colors.text,
    shadowOffset: { height: -2, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
  },
  grabArea: { alignItems: 'center', justifyContent: 'center', minHeight: 28 },
  grabber: { backgroundColor: colors.border, borderRadius: 3, height: 5, width: 44 },
  content: { paddingBottom: 20, paddingHorizontal: 16 },
});
