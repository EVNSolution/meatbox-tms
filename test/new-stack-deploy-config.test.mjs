import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = path.join(ROOT, 'deploy/new-stack');

function env(source) {
  return Object.fromEntries(source.trim().split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function configure(t, mode, { apiOrigin = 'https://3.36.96.156', webOrigin = apiOrigin } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-deploy-config-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const api = path.join(temporary, 'api.env');
  const web = path.join(temporary, 'web.env');
  const owners = path.join(temporary, 'owners.env');
  const output = path.join(temporary, 'output');
  await fs.writeFile(api, `MEATBOX_PUBLIC_ORIGIN=${apiOrigin}\nCUSTOM_PRIVATE_SETTING=preserved\n`);
  await fs.writeFile(web, `MEATBOX_LEGACY_PUBLIC_ORIGIN=${webOrigin}\n`);
  await fs.writeFile(owners, 'MEATBOX_RESOURCES_OWNER=node\n');
  await run(process.execPath, [path.join(DEPLOY, 'configure-mode.mjs'), mode, api, web, owners, output]);
  return {
    api: env(await fs.readFile(path.join(output, 'api.env'), 'utf8')),
    web: env(await fs.readFile(path.join(output, 'web.env'), 'utf8')),
    owners: env(await fs.readFile(path.join(output, 'owners.env'), 'utf8')),
  };
}

function shellFunction(source, name, endMarker) {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${name} must be extractable for isolated execution`);
  return source.slice(start, end);
}

async function shellHarness(t, prefix, functions, invocation) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const harness = path.join(temporary, 'preflight.sh');
  await fs.writeFile(harness, ['#!/bin/sh', 'set -eu', ...functions, invocation, ''].join('\n'), { mode: 0o755 });
  return { temporary, harness };
}

async function rolloutRevisionPreflight(t, { candidateRevision, manifestRevision, expectedRevision, activeRevision }) {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const { temporary, harness } = await shellHarness(
    t,
    'meatbox-rollout-revision-',
    [shellFunction(rollout, 'validate_rollout_revisions', '# END_VALIDATE_ROLLOUT_REVISIONS')],
    'validate_rollout_revisions "$1" "$2" "$3"',
  );
  const release = path.join(temporary, 'release');
  const current = path.join(temporary, 'current');
  await fs.mkdir(release);
  await fs.mkdir(current);
  await fs.writeFile(path.join(release, 'REVISION'), `${candidateRevision}\n`);
  await fs.writeFile(path.join(release, 'MANIFEST.json'), `${JSON.stringify({ git: { head: manifestRevision } })}\n`);
  await fs.writeFile(path.join(current, 'REVISION'), `${activeRevision}\n`);
  return run('sh', [harness, release, current, expectedRevision]);
}

async function activeReleasePreflight(t, {
  expectedDeployment,
  actualReleaseId = expectedDeployment?.split(':')[1],
  mode = 'native',
  modeReleaseId = actualReleaseId,
  currentTarget = 'release',
  firstInstall = false,
  scriptName = 'rollout.sh',
  verifierExit = 0,
} = {}) {
  const rollout = await fs.readFile(path.join(DEPLOY, scriptName), 'utf8');
  const { temporary, harness } = await shellHarness(
    t,
    'meatbox-active-release-',
    [shellFunction(rollout, 'validate_active_release', '# END_VALIDATE_ACTIVE_RELEASE')],
    'validate_active_release "$1" "$2" "$3" "$4"',
  );
  const releases = path.join(temporary, 'releases');
  const current = path.join(temporary, 'current');
  const modeFile = path.join(temporary, 'deployment-mode');
  await fs.mkdir(releases);
  if (!firstInstall) {
    const release = currentTarget === 'release'
      ? path.join(releases, actualReleaseId)
      : path.join(temporary, 'outside-release');
    await fs.mkdir(path.join(release, 'tools'), { recursive: true });
    await fs.writeFile(path.join(release, 'MANIFEST.json'), `${JSON.stringify({ releaseId: actualReleaseId })}\n`);
    await fs.writeFile(
      path.join(release, 'tools/package-new-stack.mjs'),
      `#!/usr/bin/env node\nprocess.exit(${verifierExit});\n`,
      { mode: 0o755 },
    );
    await fs.symlink(release, current);
    await fs.writeFile(modeFile, `${mode} ${modeReleaseId}\n`);
  }
  return run('sh', [harness, current, releases, modeFile, expectedDeployment ?? '']);
}

async function restoreTargetPreflight(t, {
  releaseId,
  manifestReleaseId = releaseId,
  mode = 'native',
  modeReleaseId = releaseId,
  target = 'release',
  verifierExit = 0,
  firstInstall = false,
} = {}) {
  const rollback = await fs.readFile(path.join(DEPLOY, 'rollback.sh'), 'utf8');
  const { temporary, harness } = await shellHarness(
    t,
    'meatbox-restore-target-',
    [shellFunction(rollback, 'validate_restore_target', '# END_VALIDATE_RESTORE_TARGET')],
    'validate_restore_target "$1" "$2" "$3"',
  );
  const config = path.join(temporary, 'config');
  const releases = path.join(temporary, 'releases');
  const current = path.join(temporary, 'current');
  await fs.mkdir(config);
  await fs.mkdir(releases);
  if (!firstInstall) {
    const release = target === 'outside'
      ? path.join(temporary, 'outside', releaseId)
      : path.join(releases, releaseId);
    if (target !== 'missing') {
      await fs.mkdir(path.join(release, 'tools'), { recursive: true });
      await fs.writeFile(path.join(release, 'MANIFEST.json'), `${JSON.stringify({ releaseId: manifestReleaseId })}\n`);
      await fs.writeFile(
        path.join(release, 'tools/package-new-stack.mjs'),
        `#!/usr/bin/env node\nprocess.exit(${verifierExit});\n`,
        { mode: 0o755 },
      );
    }
    await fs.writeFile(path.join(config, 'new-current-link.txt'), `${release}\n`);
    await fs.writeFile(path.join(config, 'deployment-mode'), `${mode} ${modeReleaseId}\n`);
  }
  return run('sh', [harness, config, releases, current]);
}

test('native mode makes Kotlin the only owner without discarding existing API configuration', async t => {
  const result = await configure(t, 'native');
  assert.equal(result.api.MEATBOX_PUBLIC_ORIGIN, 'https://3.36.96.156');
  assert.equal(result.api.CUSTOM_PRIVATE_SETTING, 'preserved');
  assert.equal(result.api.MEATBOX_AUTH_ENABLED, 'true');
  assert.equal(result.api.MEATBOX_AUTH_ACCESS_FILE, '/var/lib/meatbox-demo/access.json');
  assert.equal(result.api.MEATBOX_DISPATCH_ENABLED, 'true');
  assert.equal(result.api.MEATBOX_DISPATCH_STATE_DIR, '/var/lib/meatbox-demo/dispatch-state');
  assert.equal(result.api.MEATBOX_RESOURCE_DATABASE, '/var/lib/meatbox-demo/resources/resources.sqlite');
  assert.equal(result.web.MEATBOX_KOTLIN_API_ORIGIN, 'http://127.0.0.1:8081');
  assert.deepEqual(result.owners, {
    MEATBOX_RESOURCES_OWNER: 'kotlin',
    MEATBOX_AUTH_OWNER: 'kotlin',
    MEATBOX_DISPATCH_OWNER: 'kotlin',
  });
});

test('connected mode retains Node ownership for authentication and dated dispatch', async t => {
  const result = await configure(t, 'connected');
  assert.equal(result.api.MEATBOX_AUTH_ENABLED, 'false');
  assert.equal(result.api.MEATBOX_DISPATCH_ENABLED, 'false');
  assert.equal(result.owners.MEATBOX_AUTH_OWNER, 'node');
  assert.equal(result.owners.MEATBOX_DISPATCH_OWNER, 'node');
  assert.equal(result.owners.MEATBOX_RESOURCES_OWNER, 'kotlin');
});

test('configuration refuses a public-origin mismatch before writing candidates', async t => {
  await assert.rejects(configure(t, 'native', { webOrigin: 'https://example.invalid' }), error => {
    assert.match(error.stderr, /public origins must match/);
    return true;
  });
});

test('slot units run the candidate from its own slot with bounded API memory', async () => {
  const api = await fs.readFile(path.join(DEPLOY, 'meatbox-api@.service'), 'utf8');
  const web = await fs.readFile(path.join(DEPLOY, 'meatbox-web@.service'), 'utf8');
  assert.doesNotMatch(api, /meatbox-gateway\.service/);
  assert.doesNotMatch(web, /meatbox-gateway\.service/);
  assert.match(web, /Requires=meatbox-api@%i\.service/);
  assert.match(api, /-Xmx256m/);
  assert.match(api, /MemoryMax=640M/);
  assert.match(api, /ReadWritePaths=\/var\/lib\/meatbox-demo/);
  for (const unit of [api, web]) {
    assert.match(unit, /EnvironmentFile=\/etc\/meatbox-tms\/slot-%i\.env/);
    assert.match(unit, /\/opt\/meatbox-tms\/slots\/%i\//);
    assert.doesNotMatch(unit, /\/opt\/meatbox-tms\/current/);
  }
});

test('rollout backs up live data before any service change and switches traffic only after the candidate is healthy', async () => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const order = [
    'VACUUM INTO',
    'sha256sum -c SHA256SUMS',
    'caddy validate --config "$BACKUP_DIR/config/Caddyfile.candidate"',
    '\nMUTATED=1\n',
    'systemctl start "meatbox-api@$TARGET_SLOT.service"',
    'wait_http "http://127.0.0.1:$TARGET_API_PORT/actuator/health"',
    'systemctl start "meatbox-web@$TARGET_SLOT.service"',
    'wait_http "http://127.0.0.1:$TARGET_WEB_PORT/login"',
    'mv -f "$CADDY_FILE.next" "$CADDY_FILE"',
    '\nsystemctl reload caddy\n',
    'install -m 0600 "$BACKUP_DIR/config/push-lab-web.env.candidate" "$PUSH_ENV"',
    '\nstop_old_slot\n',
    'ln -s "$TARGET_RELEASE" "$NEW_CURRENT.next"',
    '\nMUTATED=0\ntrap - EXIT',
  ];
  let previous = -1;
  for (const marker of order) {
    const index = rollout.indexOf(marker);
    assert.ok(index > previous, `expected ${JSON.stringify(marker)} after the previous step`);
    previous = index;
  }
  const cutover = rollout.indexOf('\nMUTATED=1\n');
  const reload = rollout.indexOf('\nsystemctl reload caddy\n');
  const stops = [...rollout.matchAll(/systemctl stop "?meatbox-(?:web|api)[@.]/g)].map(match => match.index);
  // Before the switch the only stop is the stale candidate slot; the serving slot stops only inside stop_old_slot.
  for (const index of stops.filter(index => index > cutover && index < reload)) {
    assert.match(rollout.slice(index, index + 60), /TARGET_SLOT/);
  }
  const activeChecks = [...rollout.matchAll(/validate_active_release "\$NEW_CURRENT"/g)].map(match => match.index);
  assert.equal(activeChecks.length, 2);
  assert.ok(activeChecks[0] < cutover && activeChecks[1] > rollout.indexOf('\nstop_old_slot\n'));
  assert.match(rollout, /ss -Htn state established/);
  assert.match(rollout, /printf 'native %s\\n' "\$RELEASE_ID" > "\$MODE_FILE\.next"/);
  assert.match(rollout, /ACTIVE_SLOT_FILE=\$ENV_ROOT\/active-slot/);
  assert.doesNotMatch(rollout, /npm ci/);
});

test('rollout rolls back in reverse order and never stops the serving slot before traffic moved', async () => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const body = rollout.slice(rollout.indexOf('rollback() {'), rollout.indexOf('trap rollback EXIT HUP INT TERM'));
  const steps = ['cp -a "$BACKUP_DIR/config/$name" "$ENV_ROOT/$name"', 'start_old_slot', 'systemctl reload caddy',
    'install -m 0600 "$BACKUP_DIR/config/push-lab-web.env" "$PUSH_ENV"', 'systemctl stop "meatbox-web@$TARGET_SLOT.service" "meatbox-api@$TARGET_SLOT.service"'];
  let previous = -1;
  for (const step of steps) { const index = body.indexOf(step); assert.ok(index > previous, step); previous = index; }
  assert.match(body, /if \[ "\$OLD_STOPPED" -eq 1 \]; then\n\s+start_old_slot/);
  assert.match(body, /if \[ "\$CADDY_SWITCHED" -eq 1 \]/);
});

test('rollout accepts only native mode', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-rollout-mode-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await assert.rejects(
    run('sh', [path.join(DEPLOY, 'rollout.sh'), temporary, 'a'.repeat(40), 'connected', 'none']),
    error => error.code === 64 && error.stderr.includes('only native mode is deployable'),
  );
});

async function slotPreflight(t, { caddy, slot }) {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const { temporary, harness } = await shellHarness(
    t,
    'meatbox-slot-preflight-',
    [
      shellFunction(rollout, 'slot_web_port', '# END_SLOT_PORTS'),
      shellFunction(rollout, 'resolve_slots', '# END_RESOLVE_SLOTS'),
    ],
    'resolve_slots "$1" "$2" && printf "%s %s %s %s %s\\n" "$ACTIVE_SLOT" "$TARGET_SLOT" "$CURRENT_WEB_PORT" "$TARGET_WEB_PORT" "$TARGET_API_PORT"',
  );
  const caddyFile = path.join(temporary, 'Caddyfile');
  const slotFile = path.join(temporary, 'active-slot');
  await fs.writeFile(caddyFile, caddy);
  if (slot !== undefined) await fs.writeFile(slotFile, `${slot}\n`);
  const { stdout } = await run('sh', [harness, caddyFile, slotFile]);
  return stdout.trim();
}

const caddyWith = port => `https://3.36.96.156 {\n\thandle /push-lab/* {\n\t\treverse_proxy 127.0.0.1:3300\n\t}\n\thandle {\n\t\treverse_proxy 127.0.0.1:${port}\n\t}\n}\n`;

test('slot resolution moves legacy to green, then alternates blue and green with matching ports', async t => {
  assert.equal(await slotPreflight(t, { caddy: caddyWith(4173) }), 'legacy green 4173 4174 8082');
  assert.equal(await slotPreflight(t, { caddy: caddyWith(4173), slot: 'blue' }), 'blue green 4173 4174 8082');
  assert.equal(await slotPreflight(t, { caddy: caddyWith(4174), slot: 'green' }), 'green blue 4174 4173 8081');
  await assert.rejects(
    slotPreflight(t, { caddy: caddyWith(4174), slot: 'blue' }),
    error => error.code === 65 && error.stderr.includes('does not match the active slot'),
  );
  await assert.rejects(
    slotPreflight(t, { caddy: caddyWith(4174) }),
    error => error.code === 65 && error.stderr.includes('legacy deployment must serve on 4173'),
  );
  await assert.rejects(
    slotPreflight(t, { caddy: caddyWith(3001) }),
    error => error.code === 65 && error.stderr.includes('exactly one web fallback'),
  );
  await assert.rejects(
    slotPreflight(t, { caddy: caddyWith(4173) + caddyWith(4174), slot: 'blue' }),
    error => error.code === 65 && error.stderr.includes('exactly one web fallback'),
  );
  await assert.rejects(
    slotPreflight(t, { caddy: caddyWith(4173), slot: 'purple' }),
    error => error.code === 65 && error.stderr.includes('active slot file is invalid'),
  );
});

test('rollout revision preflight accepts a new candidate while guarding the previous legacy revision', async t => {
  const oldRevision = 'a'.repeat(40);
  const candidateRevision = 'b'.repeat(40);
  await rolloutRevisionPreflight(t, {
    candidateRevision,
    manifestRevision: candidateRevision,
    expectedRevision: oldRevision,
    activeRevision: oldRevision,
  });

  await assert.rejects(
    rolloutRevisionPreflight(t, {
      candidateRevision,
      manifestRevision: candidateRevision,
      expectedRevision: oldRevision,
      activeRevision: 'c'.repeat(40),
    }),
    error => error.code === 65 && error.stderr.includes('active legacy revision changed'),
  );

  await assert.rejects(
    rolloutRevisionPreflight(t, {
      candidateRevision,
      manifestRevision: 'd'.repeat(40),
      expectedRevision: oldRevision,
      activeRevision: oldRevision,
    }),
    error => error.code === 65 && error.stderr.includes('candidate revision does not match manifest git.head'),
  );

  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  assert.ok(rollout.indexOf('validate_rollout_revisions "$RELEASE_SOURCE"') < rollout.indexOf('mkdir -p "$NEW_RELEASES"'));
});

test('rollout active-release preflight enforces first-install and existing-deployment CAS', async t => {
  const activeReleaseId = `${'a'.repeat(12)}-${'b'.repeat(16)}`;
  const activeDeployment = `native:${activeReleaseId}`;
  await activeReleasePreflight(t, { expectedDeployment: 'none', firstInstall: true });
  await activeReleasePreflight(t, { expectedDeployment: '', firstInstall: true });
  await activeReleasePreflight(t, { expectedDeployment: activeDeployment });

  await assert.rejects(
    activeReleasePreflight(t, {
      expectedDeployment: `native:${'c'.repeat(12)}-${'d'.repeat(16)}`,
      actualReleaseId: activeReleaseId,
    }),
    error => error.code === 65 && error.stderr.includes('active new-stack target changed'),
  );
  await assert.rejects(
    activeReleasePreflight(t, { expectedDeployment: activeDeployment, currentTarget: 'outside' }),
    error => error.code === 65 && error.stderr.includes('active new-stack target changed'),
  );
  await assert.rejects(
    activeReleasePreflight(t, { expectedDeployment: activeDeployment, mode: 'connected' }),
    error => error.code === 65 && error.stderr.includes('deployment mode does not match expected active deployment'),
  );
  await assert.rejects(
    activeReleasePreflight(t, {
      expectedDeployment: activeDeployment,
      modeReleaseId: `${'e'.repeat(12)}-${'f'.repeat(16)}`,
    }),
    error => error.code === 65 && error.stderr.includes('deployment mode does not match expected active deployment'),
  );
  await assert.rejects(
    activeReleasePreflight(t, { expectedDeployment: activeDeployment, verifierExit: 23 }),
    error => error.code === 23,
  );
  await assert.rejects(
    activeReleasePreflight(t, { expectedDeployment: '', actualReleaseId: activeReleaseId }),
    error => error.code === 64 && error.stderr.includes('requires EXPECTED_ACTIVE_DEPLOYMENT'),
  );
});

test('rollout holds the shared release lock and rollback delegates to the same rollout', async t => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const rollback = await fs.readFile(path.join(DEPLOY, 'rollback.sh'), 'utf8');
  const { temporary, harness } = await shellHarness(
    t,
    'meatbox-rollout-lock-',
    [shellFunction(rollout, 'acquire_release_lock', '# END_ACQUIRE_RELEASE_LOCK')],
    'acquire_release_lock "$1"',
  );
  const bin = path.join(temporary, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'flock'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(
    run('sh', [harness, path.join(temporary, 'release.lock')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    }),
    error => error.code === 75 && error.stderr.includes('another release operation is in progress'),
  );
  assert.match(rollout, /LOCK_FILE=\/run\/lock\/meatbox-tms-release\.lock/);
  assert.ok(rollout.indexOf('acquire_release_lock "$LOCK_FILE"') < rollout.indexOf('validate_active_release "$NEW_CURRENT"'));
  assert.ok(rollout.indexOf('acquire_release_lock "$LOCK_FILE"') < rollout.indexOf('trap rollback EXIT HUP INT TERM'));
  assert.doesNotMatch(rollout, /flock[^\n]*-u/);
  assert.doesNotMatch(rollback, /systemctl|flock/);
  assert.ok(rollback.indexOf('install -m 0600 "$BACKUP_DIR/config/$name" "$ENV_ROOT/$name"') < rollback.indexOf('exec "$SCRIPT_DIRECTORY/rollout.sh"'));
  assert.match(rollback, /exec "\$SCRIPT_DIRECTORY\/rollout\.sh" "\$RESTORE_RELEASE_TARGET" "\$LEGACY_REVISION" native "\$EXPECTED_ACTIVE_DEPLOYMENT"/);
});

test('standalone rollback validates the restore target before touching anything', async t => {
  const releaseId = `${'1'.repeat(12)}-${'2'.repeat(16)}`;
  await restoreTargetPreflight(t, { releaseId });

  await assert.rejects(
    restoreTargetPreflight(t, { firstInstall: true }),
    error => error.code === 66 && error.stderr.includes('nothing to roll back to'),
  );
  await assert.rejects(
    restoreTargetPreflight(t, { releaseId, target: 'outside' }),
    error => error.code === 65 && error.stderr.includes('outside immutable releases'),
  );
  await assert.rejects(
    restoreTargetPreflight(t, { releaseId, target: 'missing' }),
    error => error.code === 66 && error.stderr.includes('restore release target is missing'),
  );
  await assert.rejects(
    restoreTargetPreflight(t, {
      releaseId,
      manifestReleaseId: `${'3'.repeat(12)}-${'4'.repeat(16)}`,
    }),
    error => error.code === 65 && error.stderr.includes('manifest does not match target'),
  );
  await assert.rejects(
    restoreTargetPreflight(t, { releaseId, verifierExit: 24 }),
    error => error.code === 24,
  );
  await assert.rejects(
    restoreTargetPreflight(t, { releaseId, mode: 'connected', modeReleaseId: `${'5'.repeat(12)}-${'6'.repeat(16)}` }),
    error => error.code === 65 && error.stderr.includes('restore deployment mode does not match target'),
  );

  const rollback = await fs.readFile(path.join(DEPLOY, 'rollback.sh'), 'utf8');
  assert.ok(rollback.indexOf('validate_restore_target "$BACKUP_DIR/config"') < rollback.indexOf('install -m 0600'));
});

test('Push Lab session cutover moves the reviewed URL to the target slot and accepts an already-current value', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-push-env-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const input = path.join(temporary, 'input.env');
  const output = path.join(temporary, 'output.env');
  const source = Buffer.concat([
    Buffer.from('PUSH_LAB_ADMIN_ALLOWLIST=kim,lee\r\nPUSH_LAB_SECRET_KEY='),
    Buffer.from([0xff, 0x00, 0x3d]),
    Buffer.from('\r\nPUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:8081/api/session\r\nUNRELATED=value\r\n'),
  ]);
  await fs.writeFile(input, source);
  await run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output, '8082']);
  assert.deepEqual(
    await fs.readFile(output),
    Buffer.from(source.toString('latin1').replace('http://127.0.0.1:8081/api/session', 'http://127.0.0.1:8082/api/session'), 'latin1'),
  );
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);

  await fs.rename(output, input);
  await run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output, '8082']);
  assert.deepEqual(await fs.readFile(output), await fs.readFile(input));
  await fs.rm(output);
  await run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output, '8081']);
  assert.match(await fs.readFile(output, 'latin1'), /127\.0\.0\.1:8081\/api\/session/);
});

test('Push Lab session cutover fails closed for an unexpected URL, duplicate URL or unknown port', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-push-env-invalid-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const input = path.join(temporary, 'input.env');
  const output = path.join(temporary, 'output.env');
  await fs.writeFile(input, 'PUSH_LAB_TMS_SESSION_URL=https://example.invalid/api/session\n');
  await assert.rejects(
    run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output, '8082']),
    error => error.stderr.includes('unexpected PUSH_LAB_TMS_SESSION_URL'),
  );
  await fs.writeFile(input, 'PUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:3001/api/session\nPUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:3001/api/session\n');
  await assert.rejects(
    run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output, '8082']),
    error => error.stderr.includes('exactly one PUSH_LAB_TMS_SESSION_URL'),
  );
  await fs.writeFile(input, 'PUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:8081/api/session\n');
  await assert.rejects(
    run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output, '9999']),
    error => error.code === 64,
  );
});

test('rollout prepares the Push Lab cutover before mutation and applies it only after the traffic switch', async () => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const backup = rollout.indexOf('cp -a "$PUSH_ENV" "$BACKUP_DIR/config/push-lab-web.env"');
  const preflight = rollout.indexOf('node "$TOOLS_DIR/configure-push-session-url.mjs"');
  const cutover = rollout.indexOf('\nMUTATED=1\n');
  const reload = rollout.indexOf('\nsystemctl reload caddy\n');
  const install = rollout.indexOf('install -m 0600 "$BACKUP_DIR/config/push-lab-web.env.candidate" "$PUSH_ENV"');
  assert.ok(backup >= 0 && backup < preflight && preflight < cutover);
  assert.ok(reload > cutover && install > reload);
  assert.match(rollout, /configure-push-session-url\.mjs" \\\n[^\n]*"\$TARGET_API_PORT"/);
  assert.match(rollout, /PUSH_WEB_SERVICE=meatbox-push-lab-web\.service/);
  assert.match(rollout, /systemctl restart "\$PUSH_WEB_SERVICE"/);
  assert.match(rollout, /cmp "\$PUSH_ENV" "\$BACKUP_DIR\/config\/push-lab-web\.env"/);
  assert.doesNotMatch(rollout, /push-lab-worker/);
});
