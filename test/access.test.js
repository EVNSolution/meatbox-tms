'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { createAccess, AccessError } = require('../lib/access');

const execFileAsync = promisify(execFile);

async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-access-'));
  const file = path.join(directory, 'access.json');
  const access = createAccess({ file, ...options });
  return { access, file };
}

function rejectsCode(code) {
  return (error) => error instanceof AccessError && error.code === code;
}

test('registration requires a valid, unexpired, single-use invitation', async () => {
  let clock = 1_000;
  const { access } = await fixture({ now: () => clock });
  const invite = await access.issueInvite({ expiresInMs: 100 });

  await assert.rejects(
    access.register({ username: 'first.user', password: 'correct horse battery', invite: 'wrong-invitation-code' }),
    rejectsCode('INVALID_INVITE'),
  );
  clock = 1_101;
  await assert.rejects(
    access.register({ username: 'first.user', password: 'correct horse battery', invite }),
    rejectsCode('INVALID_INVITE'),
  );

  clock = 2_000;
  const liveInvite = await access.issueInvite();
  const user = await access.register({ username: 'First.User', password: 'correct horse battery', invite: liveInvite, displayName: 'First User' });
  assert.equal(user.username, 'first.user');
  await assert.rejects(
    access.register({ username: 'second.user', password: 'another secure password', invite: liveInvite }),
    rejectsCode('INVALID_INVITE'),
  );
});

test('passwords are stored as scrypt hashes and login errors do not expose secrets', async () => {
  const { access, file } = await fixture();
  const invite = await access.issueInvite();
  const password = 'twelve chars minimum';
  await access.register({ username: 'developer', password, invite });

  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.match(stored.users.developer.passwordHash, /^scrypt\$/);
  assert.equal(JSON.stringify(stored).includes(password), false);
  assert.equal(Object.values(stored.invites).some((entry) => JSON.stringify(entry).includes(invite)), false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  await assert.rejects(access.login({ username: 'developer', password: 'definitely incorrect' }), rejectsCode('BAD_CREDENTIALS'));
  const login = await access.login({ username: 'Developer', password });
  assert.equal(login.user.username, 'developer');
  assert.equal((await access.session(login.token)).username, 'developer');
});

test('sessions expire, logout, and are invalidated when a user is disabled', async () => {
  let clock = 10_000;
  const { access } = await fixture({ now: () => clock, sessionTtlMs: 50 });
  const invite = await access.issueInvite();
  await access.register({ username: 'session.user', password: 'correct horse battery', invite });

  const expired = await access.login({ username: 'session.user', password: 'correct horse battery' });
  clock += 51;
  assert.equal(await access.session(expired.token), null);

  const loggedOut = await access.login({ username: 'session.user', password: 'correct horse battery' });
  await access.logout(loggedOut.token);
  assert.equal(await access.session(loggedOut.token), null);

  const disabled = await access.login({ username: 'session.user', password: 'correct horse battery' });
  await access.disableUser('session.user');
  assert.equal(await access.session(disabled.token), null);
  await assert.rejects(access.login({ username: 'session.user', password: 'correct horse battery' }), rejectsCode('USER_DISABLED'));
});

test('session rechecks logout after yielding for persistent user state', async () => {
  const { access } = await fixture();
  const invite = await access.issueInvite();
  await access.register({ username: 'logout.race', password: 'correct horse battery', invite });
  const login = await access.login({ username: 'logout.race', password: 'correct horse battery' });

  const pendingSession = access.session(login.token);
  await access.logout(login.token);
  assert.equal(await pendingSession, null);
});

test('sessions observe a user disabled by another process', async () => {
  const { access, file } = await fixture();
  const invite = await access.issueInvite();
  await access.register({ username: 'external.user', password: 'correct horse battery', invite });
  const login = await access.login({ username: 'external.user', password: 'correct horse battery' });

  const otherProcess = createAccess({ file });
  await otherProcess.disableUser('external.user');
  assert.equal(await access.session(login.token), null);
});

test('concurrent registration cannot consume the same invitation twice', async () => {
  const { access } = await fixture();
  const invite = await access.issueInvite();
  const results = await Promise.allSettled([
    access.register({ username: 'concurrent.one', password: 'correct horse battery', invite }),
    access.register({ username: 'concurrent.two', password: 'correct horse battery', invite }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'INVALID_INVITE');
});

test('separate access instances preserve concurrent invite and registration mutations', async () => {
  const { access: first, file } = await fixture();
  const second = createAccess({ file });
  const firstInvite = await first.issueInvite();

  const [registered, secondInvite] = await Promise.all([
    first.register({ username: 'locked.one', password: 'correct horse battery', invite: firstInvite }),
    second.issueInvite(),
  ]);
  assert.equal(registered.username, 'locked.one');
  await second.register({ username: 'locked.two', password: 'correct horse battery', invite: secondInvite });

  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(stored.users).sort(), ['locked.one', 'locked.two']);
  assert.equal(Object.keys(stored.invites).length, 2);
});

test('a persistent external lock fails closed without stealing it', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-access-lock-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'access.json');
  await fs.mkdir(`${file}.lock`, { mode: 0o700 });
  const access = createAccess({ file, lockTimeoutMs: 10 });

  await assert.rejects(access.issueInvite(), rejectsCode('CONFIGURATION'));
  assert.equal((await fs.stat(`${file}.lock`)).isDirectory(), true);
});

test('validates usernames, passwords, duplicate users, and invite lifetime', async () => {
  const { access } = await fixture();
  await assert.rejects(access.issueInvite({ expiresInMs: 0 }), rejectsCode('VALIDATION'));
  const invite = await access.issueInvite();
  await assert.rejects(access.register({ username: '../bad', password: 'correct horse battery', invite }), rejectsCode('VALIDATION'));
  await assert.rejects(access.register({ username: 'valid.user', password: 'short', invite }), rejectsCode('VALIDATION'));
  await assert.rejects(access.login({ username: 'unknown.user', password: 'correct horse battery' }), rejectsCode('BAD_CREDENTIALS'));

  await access.register({ username: 'valid.user', password: 'correct horse battery', invite });
  const secondInvite = await access.issueInvite();
  await assert.rejects(
    access.register({ username: 'VALID.USER', password: 'correct horse battery', invite: secondInvite }),
    rejectsCode('USERNAME_TAKEN'),
  );
});

test('invite CLI writes the secret to a new 0600 file without printing it', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-access-cli-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'access.json');
  const output = path.join(directory, 'invite.txt');
  const cli = path.join(__dirname, '..', 'scripts', 'manage-access.js');

  const result = await execFileAsync(process.execPath, [cli, 'issue-invite', '--file', file, '--output', output, '--hours', '1']);
  const invitation = (await fs.readFile(output, 'utf8')).trim();
  assert.equal(result.stdout.trim(), output);
  assert.equal(result.stdout.includes(invitation), false);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.ok(invitation.length >= 32);
});
