'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ACCESS_RULES = Object.freeze({
  username: { min: 3, max: 40, pattern: '[A-Za-z0-9](?:[A-Za-z0-9_.]|-){2,39}' },
  password: { min: 12, max: 128 },
  invite: { min: 16, max: 256 },
  displayName: { max: 80 },
});
const USERNAME = new RegExp(`^(?:${ACCESS_RULES.username.pattern})$`);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 5_000;
const SESSION_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 32 * 1024 * 1024 };
const DUMMY_PASSWORD_HASH = 'scrypt$16384$8$1$bWVhdGJveC1kdW1teS1hdXRoLXYx$7oXDmmzQEtUDq-VK7IduWHxW2PhfjcoTvfAOwEjp7Pa1AfBriltGWsIO8w7jwi3dtEwnPFlXoctKmBQVhB_6nQ';

class AccessError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
    this.field = field;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scrypt(password, salt, options = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, options.keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash.toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, rawN, rawR, rawP, salt, expected] = String(encoded).split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const options = { ...SCRYPT, N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  if (!Number.isSafeInteger(options.N) || !Number.isSafeInteger(options.r) || !Number.isSafeInteger(options.p)) return false;
  const expectedBuffer = Buffer.from(expected, 'base64url');
  const actual = await scrypt(password, salt, { ...options, keylen: expectedBuffer.length });
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function publicUser(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    createdAt: user.createdAt,
  };
}

function validateUsername(value) {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!USERNAME.test(username)) {
    throw new AccessError('VALIDATION', 'Username must be 3-40 ASCII letters, numbers, dots, underscores, or hyphens.', 'username');
  }
  return username.toLowerCase();
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < ACCESS_RULES.password.min || value.length > ACCESS_RULES.password.max) {
    throw new AccessError('VALIDATION', 'Password must be 12-128 characters.', 'password');
  }
  return value;
}

function validateDisplayName(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > ACCESS_RULES.displayName.max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AccessError('VALIDATION', 'Display name must be 1-80 printable characters.', 'displayName');
  }
  return value.trim();
}

async function readStore(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed.version !== 1 || !parsed.users || !parsed.invites) throw new Error('unsupported access file');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, users: {}, invites: {} };
    throw new AccessError('CONFIGURATION', `Cannot read access data: ${error.message}`);
  }
}

async function saveStore(file, store) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withFileLock(file, timeoutMs, action) {
  const directory = path.dirname(file);
  const lock = `${file}.lock`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new AccessError('CONFIGURATION', 'Access data is locked; retry after the active access operation finishes.');
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }

  try {
    return await action();
  } finally {
    await fs.rmdir(lock).catch((error) => {
      throw new AccessError('CONFIGURATION', `Cannot release access data lock: ${error.message}`);
    });
  }
}

function createAccess({
  file = process.env.ACCESS_FILE,
  now = Date.now,
  sessionTtlMs = SESSION_TTL_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
  if (!file) throw new AccessError('CONFIGURATION', 'ACCESS_FILE is required.');
  if (typeof now !== 'function' || !Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0
    || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new AccessError('CONFIGURATION', 'Invalid access configuration.');
  }

  const resolvedFile = path.resolve(file);
  const sessions = new Map();
  let lastSessionPrune = now();
  let mutation = Promise.resolve();

  function serialize(action) {
    const result = mutation.then(() => withFileLock(resolvedFile, lockTimeoutMs, async () => {
      const store = await readStore(resolvedFile);
      return action(store);
    }));
    mutation = result.catch(() => {});
    return result;
  }

  function pruneSessions() {
    const currentTime = now();
    if (currentTime - lastSessionPrune < Math.min(sessionTtlMs, SESSION_PRUNE_INTERVAL_MS)) return;
    for (const [key, active] of sessions) {
      if (active.expiresAt <= currentTime) sessions.delete(key);
    }
    lastSessionPrune = currentTime;
  }

  async function register({ username: rawUsername, password: rawPassword, invite, displayName } = {}) {
    const username = validateUsername(rawUsername);
    const password = validatePassword(rawPassword);
    const cleanDisplayName = validateDisplayName(displayName);
    if (typeof invite !== 'string' || invite.length < ACCESS_RULES.invite.min || invite.length > ACCESS_RULES.invite.max) {
      throw new AccessError('INVALID_INVITE', 'Invitation is invalid or expired.', 'invite');
    }
    const passwordHash = await hashPassword(password);

    return serialize(async (store) => {
      const inviteHash = digest(invite);
      const invitation = store.invites[inviteHash];
      if (!invitation || invitation.usedAt || invitation.expiresAt <= now()) {
        throw new AccessError('INVALID_INVITE', 'Invitation is invalid or expired.', 'invite');
      }
      if (store.users[username]) throw new AccessError('USERNAME_TAKEN', 'Username is unavailable.', 'username');

      const createdAt = now();
      const user = { username, displayName: cleanDisplayName, passwordHash, createdAt, disabled: false };
      store.users[username] = user;
      invitation.usedAt = createdAt;
      invitation.usedBy = username;
      await saveStore(resolvedFile, store);
      return publicUser(user);
    });
  }

  async function login({ username: rawUsername, password: rawPassword } = {}) {
    pruneSessions();
    let username;
    try {
      username = validateUsername(rawUsername);
      validatePassword(rawPassword);
    } catch {
      throw new AccessError('BAD_CREDENTIALS', 'Unable to sign in.');
    }
    await mutation;
    const store = await readStore(resolvedFile);
    const user = store.users[username];
    const valid = await verifyPassword(rawPassword, user?.passwordHash || DUMMY_PASSWORD_HASH).catch(() => false);
    if (!user || !valid || user.disabled) {
      throw new AccessError(user?.disabled ? 'USER_DISABLED' : 'BAD_CREDENTIALS', 'Unable to sign in.');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + sessionTtlMs;
    sessions.set(digest(token), { username, expiresAt });
    return { token, user: publicUser(user), expiresAt };
  }

  async function session(token) {
    if (typeof token !== 'string' || token.length < 32) return null;
    const sessionKey = digest(token);
    const active = sessions.get(sessionKey);
    if (!active || active.expiresAt <= now()) {
      if (active) sessions.delete(sessionKey);
      return null;
    }
    await mutation;
    const user = (await readStore(resolvedFile)).users[active.username];
    const current = sessions.get(sessionKey);
    if (current !== active || current.expiresAt <= now()) {
      if (current === active) sessions.delete(sessionKey);
      return null;
    }
    if (!user || user.disabled) {
      sessions.delete(sessionKey);
      return null;
    }
    return publicUser(user);
  }

  async function logout(token) {
    if (typeof token === 'string') sessions.delete(digest(token));
  }

  async function issueInvite({ expiresInMs = INVITE_TTL_MS } = {}) {
    if (!Number.isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > 30 * 24 * 60 * 60 * 1000) {
      throw new AccessError('VALIDATION', 'Invitation lifetime must be between 1 millisecond and 30 days.');
    }
    const invite = crypto.randomBytes(32).toString('base64url');
    await serialize(async (store) => {
      store.invites[digest(invite)] = { createdAt: now(), expiresAt: now() + expiresInMs };
      await saveStore(resolvedFile, store);
    });
    return invite;
  }

  async function disableUser(rawUsername) {
    const username = validateUsername(rawUsername);
    return serialize(async (store) => {
      const user = store.users[username];
      if (!user) throw new AccessError('USER_NOT_FOUND', 'User does not exist.');
      user.disabled = true;
      user.disabledAt = now();
      for (const [key, active] of sessions) {
        if (active.username === username) sessions.delete(key);
      }
      await saveStore(resolvedFile, store);
      return publicUser(user);
    });
  }

  return { register, login, session, logout, issueInvite, disableUser };
}

module.exports = { ACCESS_RULES, AccessError, createAccess };
