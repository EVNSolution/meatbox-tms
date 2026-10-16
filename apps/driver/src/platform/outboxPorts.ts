import AsyncStorage from '@react-native-async-storage/async-storage';

import { fetchEvent, sendStopEvent, uploadPhoto } from '../api/driverApi';
import { Outbox, type OutboxItem, type OutboxPorts } from '../outbox/Outbox';
import { deleteEventPhotos, photoExists } from './photoFiles';

const KEY = 'meatbox.driver.outbox.v1';

function isItem(value: unknown): value is OutboxItem {
  const item = value as Partial<OutboxItem> | null;
  return !!item && typeof item.eventId === 'string' && typeof item.type === 'string' && typeof item.stopId === 'string'
    && typeof item.date === 'string' && typeof item.vehicleId === 'string' && Array.isArray(item.photos)
    && ['pending', 'uploading', 'sent', 'rejected'].includes(String(item.state));
}

const ports: OutboxPorts = {
  async load() {
    const raw = await AsyncStorage.getItem(KEY).catch(() => null);
    try {
      const value: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value.filter(isItem) : [];
    } catch {
      return [];
    }
  },
  async save(items) {
    await AsyncStorage.setItem(KEY, JSON.stringify(items));
  },
  now: () => Date.now(),
  photoReady: photoExists,
  uploadPhoto: (date, localPath) => uploadPhoto(date, localPath),
  sendEvent: (item, payload) =>
    sendStopEvent(item.type, { eventId: item.eventId, occurredAt: item.occurredAt, date: item.date, vehicleId: item.vehicleId }, payload),
  lookupEvent: (date, eventId) => fetchEvent(date, eventId),
  removePhotos: (item) => deleteEventPhotos(item.eventId),
};

// One queue for the whole process, so it outlives screens that mount and unmount.
const listeners = new Set<(items: readonly OutboxItem[]) => void>();
export const outbox = new Outbox(ports, (items) => listeners.forEach((listener) => listener(items)));

export function subscribeOutbox(listener: (items: readonly OutboxItem[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
