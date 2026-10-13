import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { registerPushToken, revokePushToken } from '../api/client';
import { SerialQueue } from './requestQueue';
import { parsePushData, type DriverPush } from '../domain/push';

const CHANNEL_ID = 'meatbox-driver';
const STORED_PUSH_TOKEN_KEY = 'meatbox.driver.push-registration';
const registrations = new SerialQueue();
let registeredToken: { date: string; vehicleId: string; token: string } | null = null;
export type PushStatus = 'registering' | 'ready' | 'denied' | 'unavailable';

function isSupported(): boolean {
  return Platform.OS === 'android' && Application.applicationId === 'com.evnsolution.meatbox.driver';
}

export function configurePushNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: true,
    }),
  });
}

export function registerPush(
  date: string,
  vehicleId: string,
  isCurrent: () => boolean,
  options: { token?: string; requestPermission?: boolean } = {},
): Promise<PushStatus> {
  return registrations.run(() => registerCurrent(date, vehicleId, isCurrent, options));
}

async function registerCurrent(
  date: string,
  vehicleId: string,
  isCurrent: () => boolean,
  options: { token?: string; requestPermission?: boolean },
): Promise<PushStatus> {
  if (!isCurrent() || !isSupported()) return 'unavailable';
  // Expo emits the token event even for getDevicePushTokenAsync. A completed
  // registration already owns this identical token, so do not register it twice.
  if (options.token && registeredToken?.token === options.token
    && registeredToken.date === date && registeredToken.vehicleId === vehicleId) return 'ready';
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      importance: Notifications.AndroidImportance.HIGH,
      name: '배송 알림', vibrationPattern: [0, 250, 150, 250],
    });
    let permissions = await Notifications.getPermissionsAsync();
    if (!permissions.granted && options.requestPermission !== false) permissions = await Notifications.requestPermissionsAsync();
    if (!permissions.granted) return 'denied';
    // A token event must use its supplied token; fetching again emits another event.
    const token = options.token ?? (await Notifications.getDevicePushTokenAsync()).data;
    if (!isCurrent() || typeof token !== 'string' || token.trim() === '') return 'unavailable';
    // Remove an earlier date/vehicle binding before registering this selection.
    await revokeStored();
    if (!isCurrent()) return 'unavailable';
    await registerPushToken({ date, vehicleId, token, deviceId: Application.getAndroidId(), platform: 'android' });
    await AsyncStorage.setItem(STORED_PUSH_TOKEN_KEY, JSON.stringify({ date, vehicleId, token }));
    if (!isCurrent()) {
      await revokeStored({ date, vehicleId });
      return 'unavailable';
    }
    registeredToken = { date, vehicleId, token };
    return 'ready';
  } catch {
    return 'unavailable';
  }
}

export function revokePush(date: string, vehicleId: string | null): Promise<void> {
  return registrations.run(() => revokeStored({ date, vehicleId }));
}

async function revokeStored(scope?: { date: string; vehicleId: string | null }): Promise<void> {
  const stored = await AsyncStorage.getItem(STORED_PUSH_TOKEN_KEY);
  if (!stored) return;
  const value = JSON.parse(stored) as { date: string; vehicleId?: string; token: string };
  if (scope && (scope.date !== value.date || (scope.vehicleId && value.vehicleId && scope.vehicleId !== value.vehicleId))) return;
  await revokePushToken(value.date, value.token);
  await AsyncStorage.removeItem(STORED_PUSH_TOKEN_KEY);
  registeredToken = null;
}

export function subscribePushToken(onToken: (token: string) => void): () => void {
  if (!isSupported()) return () => undefined;
  const subscription = Notifications.addPushTokenListener((token) => {
    if (token.type === 'android' && typeof token.data === 'string' && token.data.trim()) onToken(token.data);
  });
  return () => subscription.remove();
}

export function subscribePush(onPush: (push: DriverPush) => void): () => void {
  if (!isSupported()) return () => undefined;
  let active = true;
  const emit = (notification: Notifications.Notification, tapped: boolean) => {
    const content = notification.request.content;
    const push = parsePushData(content.data ?? {}, content, tapped);
    if (active && push) onPush(push);
  };
  const received = Notifications.addNotificationReceivedListener((notification) => emit(notification, false));
  const response = Notifications.addNotificationResponseReceivedListener((event) => {
    emit(event.notification, true);
    void Notifications.clearLastNotificationResponseAsync();
  });
  void Notifications.getLastNotificationResponseAsync().then((event) => {
    if (event) { emit(event.notification, true); void Notifications.clearLastNotificationResponseAsync(); }
  }).catch(() => undefined);
  return () => { active = false; received.remove(); response.remove(); };
}
