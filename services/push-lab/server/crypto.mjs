import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');

export function validateExchangeKeys(value = process.env.EXCHANGE_KEYS || '', required = process.env.NODE_ENV === 'production') {
  if (!value) return !required;
  const values = value.split(',');
  return values.length > 0 && values.every((candidate) => {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(candidate)) return false;
    const decoded = Buffer.from(candidate, 'base64');
    return decoded.length === 32 && decoded.toString('base64') === candidate;
  });
}

function keys() {
  const value = process.env.EXCHANGE_KEYS || '';
  if (!validateExchangeKeys(value)) throw new Error('EXCHANGE_KEYS must contain canonical base64 encoded 32-byte keys');
  const configured = value ? value.split(',').map((candidate) => Buffer.from(candidate, 'base64')) : [];
  const fallback = createHash('sha256').update('push-lab-local-test-key').digest();
  const result = configured.length ? configured : [fallback];
  return result;
}

export function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys()[0], iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

export function decrypt(value) {
  const [iv, tag, body] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  for (const key of keys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {}
  }
  throw new Error('exchange retry token cannot be decrypted');
}
