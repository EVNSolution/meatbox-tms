import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { validateExchangeKeys } from './crypto.mjs';

const TMS_COOKIE = 'meatbox_session';
const USERNAME = /^[a-z0-9](?:[a-z0-9_.]|-){2,39}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function sessionUrl(value) {
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/api\/session$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.pathname !== '/api/session' || url.search || url.hash
      || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function sessionCookie(req) {
  const headers = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'cookie') headers.push(req.rawHeaders[index + 1]);
  }
  if (!headers.length || headers.some((value) => value.length > 8192)) throw new ApiError(401, 'admin_session_required');
  const matches = headers.flatMap((value) => value.split(';').map((part) => part.trim()))
    .filter((part) => part.startsWith(`${TMS_COOKIE}=`));
  if (matches.length !== 1) throw new ApiError(401, 'admin_session_required');
  const token = matches[0].slice(TMS_COOKIE.length + 1);
  if (!SESSION_TOKEN.test(token)) throw new ApiError(401, 'admin_session_required');
  return token;
}

async function limitedJson(response) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw new Error('invalid content type');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4096) throw new Error('response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class TmsAdminAuth {
  constructor({
    url = process.env.PUSH_LAB_TMS_SESSION_URL,
    allowedUsernames = process.env.PUSH_LAB_TMS_ALLOWED_USERNAMES,
    exchangeKeys = process.env.EXCHANGE_KEYS,
    fetchImpl = fetch,
    timeoutMs = 1500,
    maxConcurrent = 16,
  } = {}) {
    this.url = sessionUrl(url);
    const names = typeof allowedUsernames === 'string' ? allowedUsernames.split(',').map((name) => name.trim()) : [];
    this.allowed = new Set(names);
    const keys = exchangeKeys ?? '';
    this.key = validateExchangeKeys(keys, true) ? Buffer.from(keys.split(',')[0], 'base64') : null;
    this.configured = Boolean(this.url && names.length && names.every((name) => USERNAME.test(name)) && this.key);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  async session(req) {
    if (!this.configured) throw new ApiError(503, 'tms_auth_unavailable');
    const token = sessionCookie(req);
    if (this.active >= this.maxConcurrent) throw new ApiError(503, 'tms_auth_unavailable');
    this.active++;
    let response;
    let data;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: { Cookie: `${TMS_COOKIE}=${token}`, Accept: 'application/json' },
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 401) throw new ApiError(401, 'admin_session_required');
      if (response.status !== 200) throw new Error('unexpected status');
      data = await limitedJson(response);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'tms_auth_unavailable');
    } finally {
      this.active--;
      if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
    }
    const username = data?.user?.username;
    if (typeof username !== 'string' || !USERNAME.test(username)) throw new ApiError(503, 'tms_auth_unavailable');
    if (!this.allowed.has(username)) throw new ApiError(403, 'admin_forbidden');
    const csrfToken = createHmac('sha256', this.key).update('push-lab-admin-tms-csrf:v1\0').update(token).digest('base64url');
    return { csrfToken, expiresAt: null };
  }

  async mutation(req, csrfToken) {
    const session = await this.session(req);
    const expected = Buffer.from(session.csrfToken);
    const actual = typeof csrfToken === 'string' ? Buffer.from(csrfToken) : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(403, 'csrf_invalid');
    return session;
  }
}
