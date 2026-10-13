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

export function registerPush(date: string, vehicleId: string, isCurrent: () => boolean): Promise<PushStatus> {
  return registrations.run(() => registerCurrent(date, vehicleId, isCurrent));
}

async function registerCurrent(date: string, vehicleId: string, isCurrent: () => boolean): Promise<PushStatus> {
  if (!isCurrent() || !isSupported()) return 'unavailable';
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      importance: Notifications.AndroidImportance.HIGH,
      name: '배송 알림', vibrationPattern: [0, 250, 150, 250],
    });
    let permissions = await Notifications.getPermissionsAsync();
    if (!permissions.granted) permissions = await Notifications.requestPermissionsAsync();
    if (!permissions.granted) return 'denied';
    const token = await Notifications.getDevicePushTokenAsync();
    if (!isCurrent() || typeof token.data !== 'string' || token.data.trim() === '') return 'unavailable';
    // Remove an earlier date/vehicle binding before registering this selection.
    await revokeStored();
    if (!isCurrent()) return 'unavailable';
    await registerPushToken({ date, vehicleId, token: token.data, deviceId: Application.getAndroidId(), platform: 'android' });
    await AsyncStorage.setItem(STORED_PUSH_TOKEN_KEY, JSON.stringify({ date, vehicleId, token: token.data }));
    if (!isCurrent()) {
      await revokeStored({ date, vehicleId });
      return 'unavailable';
    }
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
