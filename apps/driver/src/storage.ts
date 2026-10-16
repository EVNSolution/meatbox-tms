import AsyncStorage from '@react-native-async-storage/async-storage';

const VEHICLE_KEY = 'meatbox.driver.vehicle';

export async function readVehicleChoice(date: string): Promise<string | null> {
  const raw = await AsyncStorage.getItem(VEHICLE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { date?: string; vehicleId?: string };
    return value.date === date && typeof value.vehicleId === 'string' ? value.vehicleId : null;
  } catch {
    return null;
  }
}

export async function saveVehicleChoice(date: string, vehicleId: string | null): Promise<void> {
  if (vehicleId === null) await AsyncStorage.removeItem(VEHICLE_KEY);
  else await AsyncStorage.setItem(VEHICLE_KEY, JSON.stringify({ date, vehicleId }));
}

const NAV_APP_KEY = 'meatbox.driver.nav-app';

/** The navigation app the driver chose to use every time, or null. */
export async function readNavApp(): Promise<string | null> {
  return AsyncStorage.getItem(NAV_APP_KEY).catch(() => null);
}

export async function saveNavApp(app: string | null): Promise<void> {
  if (app === null) await AsyncStorage.removeItem(NAV_APP_KEY);
  else await AsyncStorage.setItem(NAV_APP_KEY, app);
}

// Pickup confirmation is local to this device. The server does not store it.
function pickupKey(date: string, vehicleId: string): string {
  return `meatbox.driver.pickup.${date}.${vehicleId}`;
}

export async function readPickupScans(date: string, vehicleId: string): Promise<string[]> {
  const raw = await AsyncStorage.getItem(pickupKey(date, vehicleId)).catch(() => null);
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function savePickupScans(date: string, vehicleId: string, ids: readonly string[]): Promise<void> {
  await AsyncStorage.setItem(pickupKey(date, vehicleId), JSON.stringify(ids));
}
