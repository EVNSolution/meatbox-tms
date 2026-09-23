import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { ApiError, assert } from './errors.mjs';
import { hash, token } from './crypto.mjs';
import { transaction } from './db.mjs';

const LOGIN_WINDOW = 15 * 60_000;
const LOGIN_LIMIT = 5;
const SESSION_LIFETIME = 8 * 60 * 60_000;
const CHALLENGE_LIFETIME = 5 * 60_000;

export class AdminAuth {
  constructor(db, { now = () => Date.now(), hashFile = process.env.PUSH_LAB_ADMIN_PASSWORD_HASH_FILE } = {}) {
    this.db = db;
    this.now = now;
    this.hashFile = hashFile;
  }

  #secret() {
    try {
      if (!this.hashFile) throw new Error('missing hash file');
      const stat = statSync(this.hashFile);
      if (!stat.isFile() || (stat.mode & 0o007) !== 0 || (stat.mode & 0o020) !== 0) throw new Error('unsafe hash file');
      const match = /^([0-9a-fA-F]{32,}):([0-9a-fA-F]{128})\n?$/.exec(readFileSync(this.hashFile, 'utf8'));
      if (!match || match[1].length % 2) throw new Error('invalid hash file');
      return { salt: Buffer.from(match[1], 'hex'), key: Buffer.from(match[2], 'hex') };
    } catch {
      throw new ApiError(503, 'admin_unconfigured');
    }
  }

  challenge() {
    this.#secret();
    const csrfToken = token();
    const now = this.now();
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM admin_login_challenges WHERE expires_at<=?').run(now);
      this.db.prepare('INSERT INTO admin_login_challenges(token_hash,expires_at) VALUES (?,?)').run(hash(csrfToken), now + CHALLENGE_LIFETIME);
    });
    return { csrfToken, expiresAt: now + CHALLENGE_LIFETIME };
  }

  login({ password, cookieToken, headerToken, source }) {
    const secret = this.#secret();
    const now = this.now();
    const identity = String(source || 'unknown');
    const attempts = this.db.prepare('SELECT * FROM admin_login_failures WHERE source=?').get(identity);
    if (attempts && attempts.window_started_at + LOGIN_WINDOW > now && attempts.count >= LOGIN_LIMIT) {
      throw new ApiError(429, 'login_rate_limited');
    }
    assert(typeof cookieToken === 'string' && cookieToken.length > 0 && cookieToken === headerToken, 403, 'csrf_invalid');
    const challenge = this.db.prepare('SELECT expires_at FROM admin_login_challenges WHERE token_hash=?').get(hash(cookieToken));
    assert(challenge && challenge.expires_at > now, 403, 'csrf_invalid');
    const validInput = typeof password === 'string' && password.length > 0 && password.length <= 1024;
    const candidate = scryptSync(validInput ? password : randomBytes(32), secret.salt, 64, { N: 16384, r: 8, p: 1 });
    const valid = validInput && timingSafeEqual(candidate, secret.key);
    const result = transaction(this.db, () => {
      const consumed = this.db.prepare('DELETE FROM admin_login_challenges WHERE token_hash=?').run(hash(cookieToken));
      assert(consumed.changes === 1, 403, 'csrf_invalid');
      if (!valid) {
        if (!attempts || attempts.window_started_at + LOGIN_WINDOW <= now) {
          this.db.prepare('INSERT INTO admin_login_failures(source,count,window_started_at) VALUES (?,1,?) ON CONFLICT(source) DO UPDATE SET count=1,window_started_at=excluded.window_started_at').run(identity, now);
        } else {
          this.db.prepare('UPDATE admin_login_failures SET count=count+1 WHERE source=?').run(identity);
        }
        return null;
      }
      this.db.prepare('DELETE FROM admin_login_failures WHERE source=?').run(identity);
      const sessionToken = token();
      const csrfToken = this.#csrf(sessionToken, secret.key);
      const expiresAt = now + SESSION_LIFETIME;
      this.db.prepare('INSERT INTO admin_sessions(token_hash,csrf_hash,created_at,expires_at) VALUES (?,?,?,?)')
        .run(hash(sessionToken), hash(csrfToken), now, expiresAt);
      return { sessionToken, csrfToken, expiresAt };
    });
    if (!result) throw new ApiError(401, 'invalid_credentials');
    return result;
  }

  session(sessionToken) {
    const secret = this.#secret();
    assert(typeof sessionToken === 'string' && sessionToken.length > 0, 401, 'admin_session_required');
    const row = this.db.prepare('SELECT csrf_hash,expires_at FROM admin_sessions WHERE token_hash=? AND expires_at>?')
      .get(hash(sessionToken), this.now());
    assert(row, 401, 'admin_session_required');
    const csrfToken = this.#csrf(sessionToken, secret.key);
    assert(hash(csrfToken) === row.csrf_hash, 401, 'admin_session_required');
    return { csrfToken, expiresAt: row.expires_at };
  }

  mutation(sessionToken, csrfToken) {
    const session = this.session(sessionToken);
    assert(typeof csrfToken === 'string' && csrfToken.length > 0 && csrfToken === session.csrfToken, 403, 'csrf_invalid');
    return session;
  }

  logout(sessionToken, csrfToken) {
    this.mutation(sessionToken, csrfToken);
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash(sessionToken));
  }

  #csrf(sessionToken, key) {
    return createHmac('sha256', key).update('push-lab-admin-csrf:').update(sessionToken).digest('base64url');
  }
}
