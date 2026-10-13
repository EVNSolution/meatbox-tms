export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_MEATBOX_API_BASE_URL?.trim() || 'https://3.36.96.156'
).replace(/\/+$/u, '');

export const API_ORIGIN = new URL(API_BASE_URL).origin;

export const POLL_INTERVAL_MS = 10_000;
