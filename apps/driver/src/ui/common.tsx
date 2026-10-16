import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { SvgXml } from 'react-native-svg';

import { MEATBOX_LOGO_XML } from './brandLogo';
import { colors, fontFamily, radius, TOUCH_MIN } from './theme';

export function T({ style, ...props }: TextProps) {
  return <Text maxFontSizeMultiplier={1.4} {...props} style={[styles.text, style]} />;
}

export function Logo({ height = 22 }: { height?: number }) {
  return <SvgXml height={height} width={(height * 105) / 25} xml={MEATBOX_LOGO_XML} />;
}

type ButtonTone = 'primary' | 'action' | 'secondary' | 'danger';

export function Button({
  label,
  onPress,
  onLongPress,
  tone = 'primary',
  disabled = false,
  busy = false,
  style,
  icon,
  accessibilityHint,
}: {
  label: string;
  onPress(): void;
  onLongPress?(): void;
  tone?: ButtonTone;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: ReactNode;
  accessibilityHint?: string;
}) {
  const inactive = disabled || busy;
  const filled = tone !== 'secondary';
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        toneStyles[tone],
        inactive && styles.buttonDisabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={filled ? colors.surface : colors.action} /> : icon}
      <T style={[styles.buttonText, { color: filled ? colors.surface : colors.action }]}>{label}</T>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SequenceBadge({ value, tone }: { value: number | string; tone: 'current' | 'pending' | 'done' }) {
  return (
    <View style={[styles.badge, { backgroundColor: badgeColor[tone] }]}>
      <T style={styles.badgeText}>{value}</T>
    </View>
  );
}

const badgeColor = { current: colors.brand, pending: colors.action, done: colors.done } as const;

const toneStyles = StyleSheet.create({
  primary: { backgroundColor: colors.brand, borderColor: colors.brand },
  action: { backgroundColor: colors.action, borderColor: colors.action },
  secondary: { backgroundColor: colors.surface, borderColor: colors.border },
  danger: { backgroundColor: colors.error, borderColor: colors.error },
});

export const styles = StyleSheet.create({
  text: { color: colors.text, fontFamily },
  button: {
    alignItems: 'center',
    borderRadius: radius.control,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: TOUCH_MIN + 8,
    paddingHorizontal: 16,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.75 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.card,
    borderWidth: 1,
    padding: 14,
  },
  badge: {
    alignItems: 'center',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    minWidth: 28,
    paddingHorizontal: 6,
  },
  badgeText: { color: colors.surface, fontSize: 13, fontWeight: '800' },
});
