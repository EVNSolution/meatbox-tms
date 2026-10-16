import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Alert, Linking } from 'react-native';

import { sendLocations } from '../api/driverApi';
import {
  COLLECT_INTERVAL_MS, TRACKING_NOTIFICATION, TRACKING_TASK,
} from '../domain/trackingPolicy';
import { LocationTracker, type TrackerPorts, type TrackingState } from '../tracking/LocationTracker';

const STATE_KEY = 'meatbox.driver.tracking.v1';
const GUIDE_KEY = 'meatbox.driver.tracking-guide.v1';

const ports: TrackerPorts = {
  async load() {
    const raw = await AsyncStorage.getItem(STATE_KEY).catch(() => null);
    try {
      const value = raw ? (JSON.parse(raw) as Partial<TrackingState>) : null;
      return value && typeof value.date === 'string' && typeof value.vehicleId === 'string' && Array.isArray(value.samples)
        ? { date: value.date, vehicleId: value.vehicleId, samples: value.samples, lastAttemptAt: Number(value.lastAttemptAt) || 0 }
        : null;
    } catch {
      return null;
    }
  },
  async save(state) {
    if (state) await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
    else await AsyncStorage.removeItem(STATE_KEY);
  },
  now: () => Date.now(),
  send: (date, vehicleId, samples) => sendLocations(date, vehicleId, samples),
};

export const tracker = new LocationTracker(ports);

// The system calls this with new readings, also while the screen is off. Sending rides on it: no separate timer is
// needed, and a timer would not run reliably without the screen anyway.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TRACKING_TASK, async ({ data, error }) => {
  if (error || !data) return;
  await tracker.record(data.locations);
});

async function running(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(TRACKING_TASK).catch(() => false);
}

/**
 * Keeps location collection on for a vehicle that is delivering: 30 s readings in a foreground service, sent in
 * batches by the tracker. It needs the foreground permission; without it nothing starts (the departure already told
 * the driver). Safe to call again on every state change.
 */
export async function ensureTracking(date: string, vehicleId: string): Promise<void> {
  const permission = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!permission?.granted) return;
  await tracker.start(date, vehicleId);
  if (await running()) return;
  await Location.startLocationUpdatesAsync(TRACKING_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: COLLECT_INTERVAL_MS,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: TRACKING_NOTIFICATION.title,
      notificationBody: TRACKING_NOTIFICATION.body,
      notificationColor: '#e60028',
    },
  });
}

/** Sends what is left, stops collecting and forgets the vehicle: route finished, vehicle changed, signed out. */
export async function stopTracking(): Promise<void> {
  await tracker.stop().catch(() => undefined);
  if (await running()) await Location.stopLocationUpdatesAsync(TRACKING_TASK).catch(() => undefined);
}

export function flushTracking(): Promise<unknown> {
  return tracker.flush().catch(() => undefined);
}

/**
 * Once per install: recommend "allow all the time" for location and leaving battery optimisation off, which keep the
 * collection going when the system is short of resources. Both are advice; nothing is blocked if the driver declines.
 */
export async function showTrackingGuides(): Promise<void> {
  if (await AsyncStorage.getItem(GUIDE_KEY).catch(() => null)) return;
  await AsyncStorage.setItem(GUIDE_KEY, '1').catch(() => undefined);
  const ask = (title: string, message: string, action: string) => new Promise<boolean>((resolve) => {
    Alert.alert(title, message, [
      { text: '나중에', style: 'cancel', onPress: () => resolve(false) },
      { text: action, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
  if (await ask('위치 "항상 허용" 권장', '화면이 꺼지거나 다른 앱을 쓰는 동안에도 운행 위치를 안정적으로 보내려면 위치 권한을 "항상 허용"으로 설정하는 것을 권장합니다.', '설정하기')) {
    await Location.requestBackgroundPermissionsAsync().catch(() => undefined);
  }
  if (await ask('배터리 최적화 제외 권장', '기기의 절전 기능이 위치 전송을 멈출 수 있습니다. 설정에서 이 앱을 "제한 없음"(또는 최적화 제외)으로 바꾸는 것을 권장합니다.', '설정 열기')) {
    await Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() => Linking.openSettings());
  }
}
