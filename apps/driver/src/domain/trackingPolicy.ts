// Location tracking numbers (docs/integration-contract.md section 2: collect every 30 s, send every minute).
export const COLLECT_INTERVAL_MS = 30_000;
export const SEND_INTERVAL_MS = 60_000;
/** The server takes at most 200 samples per request. */
export const MAX_BATCH = 200;
/** Samples older than this are dropped from the phone; the server keeps only the newest 120 per vehicle anyway. */
export const RETAIN_MS = 60 * 60 * 1000;
/** Hard cap while offline, twice the samples of an hour. */
export const MAX_BUFFERED = 240;
/** Batches sent in one flush, so a long offline period catches up without one endless loop. */
export const MAX_BATCHES_PER_FLUSH = 5;

export const TRACKING_TASK = 'meatbox-driver-location';
export const TRACKING_NOTIFICATION = {
  title: '미트박스 배송',
  body: '운행 중 위치를 운영팀에 전송하고 있습니다.',
} as const;
