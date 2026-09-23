export class MockSender {
  constructor(results = []) {
    this.results = [...results];
    this.sent = [];
  }

  async send(message) {
    this.sent.push(message);
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result || `mock/${this.sent.length}`;
  }
}

export function classifyProviderError(error) {
  const code = error?.code || '';
  const causeCode = error?.cause?.code;
  if (error?.name === 'AbortError'
    || ['ETIMEDOUT', 'ECONNRESET', 'DEADLINE_EXCEEDED', 'app/network-timeout'].includes(code)
    || ['ETIMEDOUT', 'ECONNRESET'].includes(causeCode)
    || (code === 'app/network-error' && !['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(causeCode))) return 'unknown';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)
    || (code === 'app/network-error' && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(causeCode))) return 'transient';
  const status = error?.httpResponse?.status ?? error?.status;
  if (['messaging/installation-id-not-registered', 'messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code)) return 'invalid_registration';
  if (code === 'messaging/invalid-argument') return 'invalid_payload';
  if (['messaging/authentication-error', 'messaging/mismatched-credential', 'messaging/third-party-auth-error'].includes(code)) return 'configuration';
  if (['messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded', 'messaging/topics-message-rate-exceeded', 'messaging/quota-exceeded'].includes(code) || status === 429) return 'rate_limited';
  if (['messaging/server-unavailable', 'messaging/internal-error'].includes(code) || (status >= 500 && status < 600)) return 'transient';
  return 'permanent';
}

export function retryAfterMs(error, now = Date.now()) {
  const headers = error?.httpResponse?.headers ?? error?.headers ?? error?.response?.headers;
  const value = error?.retryAfter ?? headers?.['retry-after'] ?? headers?.['Retry-After'] ?? headers?.get?.('retry-after');
  if (value == null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export async function sendWithTimeout(sender, message, timeoutMs = 10_000) {
  const underlying = Promise.resolve().then(() => sender.send(message));
  const settlement = underlying.then(() => undefined, () => undefined);
  let timer;
  try {
    // Firebase Admin exposes no per-send abort signal. Timeout therefore means
    // delivery is unknown; the underlying call may still settle and must not be retried.
    return await Promise.race([
      underlying,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('FCM send timed out'), {
          code: 'ETIMEDOUT',
          settlement,
        })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createSender(mode = process.env.PUSH_LAB_SENDER_MODE || 'mock') {
  if (mode === 'mock') return new MockSender();
  if (mode !== 'real') throw new Error('PUSH_LAB_SENDER_MODE must be mock or real');
  const allowlist = new Set((process.env.PUSH_LAB_REAL_FID_ALLOWLIST || '').split(',').map((value) => value.trim()).filter(Boolean));
  if (allowlist.size === 0) throw Object.assign(new Error('PUSH_LAB_REAL_FID_ALLOWLIST is required in real sender mode'), { code: 'messaging/authentication-error' });
  const [{ applicationDefault, getApps, initializeApp }, { getMessaging }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/messaging'),
  ]);
  const app = getApps()[0] || initializeApp({ credential: applicationDefault() });
  return createRealSender(getMessaging(app), allowlist);
}

export function createRealSender(messaging, allowlist) {
  return {
    send(message) {
      if (!allowlist.has(message.fid)) {
        throw Object.assign(new Error('FID is not in PUSH_LAB_REAL_FID_ALLOWLIST'), { code: 'push-lab/fid-not-allowed' });
      }
      return messaging.send(buildFcmMessage(message));
    },
  };
}

export function buildFcmMessage({ fid, deliveryId, notificationId, ttlSeconds }) {
  return {
    fid,
    data: {
      deliveryId,
      title: '[테스트] 미트박스 배송 알림',
      body: '테스트 배송 상태를 확인해 주세요.',
      notificationId,
    },
    webpush: { headers: { TTL: String(ttlSeconds) } },
  };
}
