export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_MEATBOX_API_BASE_URL?.trim() || 'https://3.36.96.156'
).replace(/\/+$/u, '');

export const API_ORIGIN = new URL(API_BASE_URL).origin;

export const POLL_INTERVAL_MS = 10_000;

/** The operations desk number for the call button, set when the app is built. Empty hides the button. */
export const OPS_PHONE = (process.env.EXPO_PUBLIC_MEATBOX_OPS_PHONE ?? '').trim();
