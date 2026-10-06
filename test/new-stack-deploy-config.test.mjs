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

async function rollbackStatePreflight(t, {
  missing,
  unsafe,
  invalid,
  invalidValue = 'invented-state',
  push = false,
  marker = push ? '1' : '0',
  scriptName = 'rollback.sh',
} = {}) {
  const rollback = await fs.readFile(path.join(DEPLOY, scriptName), 'utf8');
  const { temporary, harness } = await shellHarness(
    t,
    'meatbox-rollback-state-',
    [
      shellFunction(rollback, 'validate_systemctl_state_file', '# END_VALIDATE_SYSTEMCTL_STATE_FILE'),
      shellFunction(rollback, 'validate_rollback_state_files', '# END_VALIDATE_ROLLBACK_STATE_FILES'),
    ],
    'validate_rollback_state_files "$1" meatbox-push-lab-web.service',
  );
  const config = path.join(temporary, 'config');
  await fs.mkdir(config);
  const services = ['meatbox-gateway.service', 'meatbox-api.service', 'meatbox-web.service'];
  if (push) {
    services.push('meatbox-push-lab-web.service');
    await fs.writeFile(path.join(config, 'push-lab-web.env'), 'PUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:8081/api/session\n');
  }
  if (marker !== 'missing') await fs.writeFile(path.join(config, 'push-env-present'), `${marker}\n`);
  for (const service of services) {
    await fs.writeFile(path.join(config, `${service}.enabled`), 'enabled\n');
    await fs.writeFile(path.join(config, `${service}.active`), 'active\n');
  }
  if (missing) await fs.rm(path.join(config, missing));
  if (invalid) await fs.writeFile(path.join(config, invalid), `${invalidValue}\n`);
  if (unsafe) {
    const unsafeFile = path.join(config, unsafe);
    const target = path.join(temporary, 'unsafe-state');
    await fs.writeFile(target, 'active\n');
    await fs.rm(unsafeFile);
    await fs.symlink(target, unsafeFile);
  }
  return run('sh', [harness, config]);
}

async function restoreConfigPreflight(t, {
  deployment = 'native:test',
  missing,
  unsafe,
  scriptName = 'rollback.sh',
} = {}) {
  const rollback = await fs.readFile(path.join(DEPLOY, scriptName), 'utf8');
  const { temporary, harness } = await shellHarness(
    t,
    'meatbox-restore-config-',
    [shellFunction(rollback, 'validate_restore_config_files', '# END_VALIDATE_RESTORE_CONFIG_FILES')],
    'validate_restore_config_files "$1" "$2"',
  );
  const config = path.join(temporary, 'config');
  await fs.mkdir(config);
  const files = ['Caddyfile', 'meatbox-api.service', 'meatbox-web.service', 'api.env', 'web.env', 'owners.env'];
  if (deployment.startsWith('connected:')) files.push('10-new-stack.conf');
  if (deployment === 'none') files.splice(1);
  for (const filename of files) await fs.writeFile(path.join(config, filename), `${filename}\n`);
  if (missing) await fs.rm(path.join(config, missing));
  if (unsafe) {
    const unsafeFile = path.join(config, unsafe);
    const target = path.join(temporary, 'unsafe-config');
    await fs.writeFile(target, 'unsafe\n');
    await fs.rm(unsafeFile, { force: true });
    await fs.symlink(target, unsafeFile);
  }
  return run('sh', [harness, config, deployment]);
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

test('native services have no legacy service dependency and retain bounded API memory', async () => {
  const api = await fs.readFile(path.join(DEPLOY, 'meatbox-api-native.service'), 'utf8');
  const connectedApi = await fs.readFile(path.join(DEPLOY, 'meatbox-api.service'), 'utf8');
  const web = await fs.readFile(path.join(DEPLOY, 'meatbox-web-native.service'), 'utf8');
  assert.doesNotMatch(api, /meatbox-gateway\.service/);
  assert.doesNotMatch(web, /meatbox-gateway\.service/);
  assert.match(web, /Requires=meatbox-api\.service/);
  assert.match(api, /-Xmx256m/);
  assert.match(api, /MemoryMax=640M/);
  assert.match(connectedApi, /-Xmx128m/);
  assert.match(connectedApi, /MemoryMax=320M/);
  assert.match(api, /ReadWritePaths=\/var\/lib\/meatbox-demo/);
});

test('rollout stops every writer before taking the business-data backup', async () => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const cutover = rollout.indexOf('\nMUTATED=1\n');
  const stopWeb = rollout.indexOf('systemctl stop meatbox-web.service', cutover);
  const stopApi = rollout.indexOf('systemctl stop meatbox-api.service', cutover);
  const stopNode = rollout.indexOf('systemctl stop meatbox-gateway.service', cutover);
  const backup = rollout.indexOf('cp -a "$STATE_ROOT/access.json"', cutover);
  assert.ok(cutover >= 0 && stopWeb > cutover && stopApi > cutover && stopNode > cutover);
  assert.ok(backup > stopWeb && backup > stopApi && backup > stopNode);
  assert.match(rollout, /MODE=\$\{3:-connected\}/);
  assert.match(rollout, /systemctl disable meatbox-gateway\.service/);
  assert.match(rollout, /"\$API_ENV" "\$WEB_ENV" "\$OWNERS_ENV" "\$MODE_FILE"/);
  assert.match(rollout, /meatbox-gateway\.service\.active/);
});

test('rollout requires reviewed rollback for a native to connected transition', async t => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const { harness } = await shellHarness(
    t,
    'meatbox-rollout-transition-',
    [shellFunction(rollout, 'validate_rollout_transition', '# END_VALIDATE_ROLLOUT_TRANSITION')],
    'validate_rollout_transition "$1" "$2"',
  );
  const releaseId = `${'a'.repeat(12)}-${'b'.repeat(16)}`;
  for (const [mode, active] of [
    ['connected', 'none'],
    ['connected', `connected:${releaseId}`],
    ['native', `connected:${releaseId}`],
    ['native', `native:${releaseId}`],
  ]) await run('sh', [harness, mode, active]);
  for (const activeId of [releaseId, `${'c'.repeat(12)}-${'d'.repeat(16)}`]) {
    await assert.rejects(
      run('sh', [harness, 'connected', `native:${activeId}`]),
      error => error.code === 65 && error.stderr.includes('requires the reviewed rollback'),
    );
  }
  const guard = rollout.indexOf('validate_rollout_transition "$MODE"');
  assert.ok(guard < rollout.indexOf('mkdir -p "$NEW_RELEASES"'));
  assert.ok(guard < rollout.indexOf('npm ci --omit=dev'));
  assert.ok(guard < rollout.indexOf('\nMUTATED=1\n'));
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
  await activeReleasePreflight(t, { expectedDeployment: activeDeployment, scriptName: 'rollback.sh' });

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
      expectedDeployment: `connected:${activeReleaseId}`,
      scriptName: 'rollback.sh',
    }),
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
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const activeChecks = [...rollout.matchAll(/validate_active_release "\$NEW_CURRENT"/g)].map(match => match.index);
  assert.equal(activeChecks.length, 2);
  assert.ok(activeChecks[0] < rollout.indexOf('\nMUTATED=1\n'));
  assert.ok(activeChecks[1] > rollout.indexOf('\nMUTATED=1\n'));
  assert.ok(activeChecks[1] < rollout.indexOf('ln -s "$TARGET_RELEASE" "$NEW_CURRENT.next"'));
});

test('rollout and standalone rollback refuse a concurrent release operation through the shared lock', async t => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const rollback = await fs.readFile(path.join(DEPLOY, 'rollback.sh'), 'utf8');
  for (const [name, source] of [['rollout', rollout], ['rollback', rollback]]) {
    const { temporary, harness } = await shellHarness(
      t,
      `meatbox-${name}-lock-`,
      [shellFunction(source, 'acquire_release_lock', '# END_ACQUIRE_RELEASE_LOCK')],
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
  }
  assert.match(rollout, /LOCK_FILE=\/run\/lock\/meatbox-tms-release\.lock/);
  assert.match(rollback, /LOCK_FILE=\/run\/lock\/meatbox-tms-release\.lock/);
  assert.ok(rollout.indexOf('acquire_release_lock "$LOCK_FILE"') < rollout.indexOf('validate_active_release "$NEW_CURRENT"'));
  assert.ok(rollback.indexOf('acquire_release_lock "$LOCK_FILE"') < rollback.indexOf('validate_active_release "$NEW_CURRENT"'));
  assert.ok(rollback.indexOf('validate_active_release "$NEW_CURRENT"') < rollback.indexOf('systemctl stop meatbox-api.service'));
  assert.ok(rollout.indexOf('acquire_release_lock "$LOCK_FILE"') < rollout.indexOf('trap rollback EXIT HUP INT TERM'));
  assert.doesNotMatch(rollout, /flock[^\n]*-u/);
});

test('standalone rollback validates the restore target before stopping services', async t => {
  const releaseId = `${'1'.repeat(12)}-${'2'.repeat(16)}`;
  await restoreTargetPreflight(t, { releaseId });
  await restoreTargetPreflight(t, { firstInstall: true });

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
  assert.ok(rollback.indexOf('validate_restore_target "$BACKUP_DIR/config"') < rollback.indexOf('systemctl stop meatbox-api.service'));
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  assert.match(rollout, /PREVIOUS_RELEASE_TARGET=\$ACTIVE_RELEASE_TARGET/);
  assert.match(rollout, /ln -s "\$PREVIOUS_RELEASE_TARGET" "\$NEW_CURRENT\.rollback"/);
  assert.doesNotMatch(rollout, /previous=\$\(sed -n '1p' "\$BACKUP_DIR\/config\/new-current-link\.txt"\)/);
});

test('standalone rollback validates every required service-state backup before mutation', async t => {
  await rollbackStatePreflight(t);
  await rollbackStatePreflight(t, { push: true });
  await rollbackStatePreflight(t, { push: true, marker: 'missing' });
  await assert.rejects(
    rollbackStatePreflight(t, { marker: 'missing' }),
    error => error.code === 65 && error.stderr.includes('legacy Push Lab backup presence is unverifiable'),
  );
  await assert.rejects(
    rollbackStatePreflight(t, { missing: 'meatbox-api.service.active' }),
    error => error.code === 66 && error.stderr.includes('rollback service state is missing or unsafe'),
  );
  await assert.rejects(
    rollbackStatePreflight(t, { unsafe: 'meatbox-web.service.active' }),
    error => error.code === 66 && error.stderr.includes('rollback service state is missing or unsafe'),
  );
  await assert.rejects(
    rollbackStatePreflight(t, { invalid: 'meatbox-gateway.service.enabled' }),
    error => error.code === 65 && error.stderr.includes('rollback service state is invalid'),
  );
  await assert.rejects(
    rollbackStatePreflight(t, { invalid: 'meatbox-web.service.active', invalidValue: 'reloading' }),
    error => error.code === 65 && error.stderr.includes('rollback service state is invalid'),
  );
  await assert.rejects(
    rollbackStatePreflight(t, { invalid: 'meatbox-api.service.active', scriptName: 'rollout.sh' }),
    error => error.code === 65 && error.stderr.includes('rollback service state is invalid'),
  );
  await assert.rejects(
    rollbackStatePreflight(t, {
      push: true,
      marker: 'missing',
      missing: 'meatbox-push-lab-web.service.active',
    }),
    error => error.code === 65 && error.stderr.includes('legacy Push Lab backup presence is unverifiable'),
  );
  await assert.rejects(
    rollbackStatePreflight(t, { push: true, marker: '0' }),
    error => error.code === 65 && error.stderr.includes('conflict with absence marker'),
  );

  const rollback = await fs.readFile(path.join(DEPLOY, 'rollback.sh'), 'utf8');
  assert.ok(rollback.indexOf('validate_rollback_state_files "$BACKUP_DIR/config"') < rollback.indexOf('systemctl stop meatbox-api.service'));
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  assert.ok(rollout.indexOf('validate_rollback_state_files "$BACKUP_DIR/config"') < rollout.indexOf('\nMUTATED=0\n'));
});

test('standalone rollback requires safe configuration for the restored topology', async t => {
  await restoreConfigPreflight(t, { deployment: 'native:test' });
  await restoreConfigPreflight(t, { deployment: 'connected:test' });
  await restoreConfigPreflight(t, { deployment: 'none' });
  await assert.rejects(
    restoreConfigPreflight(t, { deployment: 'native:test', missing: 'web.env' }),
    error => error.code === 66 && error.stderr.includes('restore configuration is missing or unsafe'),
  );
  await assert.rejects(
    restoreConfigPreflight(t, { deployment: 'connected:test', unsafe: '10-new-stack.conf' }),
    error => error.code === 66 && error.stderr.includes('restore configuration is missing or unsafe'),
  );
  await assert.rejects(
    restoreConfigPreflight(t, { deployment: 'native:test', unsafe: 'Caddyfile', scriptName: 'rollout.sh' }),
    error => error.code === 66 && error.stderr.includes('restore configuration is missing or unsafe'),
  );

  const rollback = await fs.readFile(path.join(DEPLOY, 'rollback.sh'), 'utf8');
  assert.ok(rollback.indexOf('validate_restore_config_files "$BACKUP_DIR/config"') < rollback.indexOf('systemctl stop meatbox-api.service'));
});

test('Push Lab session cutover changes only the reviewed URL and accepts an already-native value', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-push-env-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const input = path.join(temporary, 'input.env');
  const output = path.join(temporary, 'output.env');
  const source = Buffer.concat([
    Buffer.from('PUSH_LAB_ADMIN_ALLOWLIST=kim,lee\r\nPUSH_LAB_SECRET_KEY='),
    Buffer.from([0xff, 0x00, 0x3d]),
    Buffer.from('\r\nPUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:3001/api/session\r\nUNRELATED=value\r\n'),
  ]);
  await fs.writeFile(input, source);
  await run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output]);
  assert.deepEqual(
    await fs.readFile(output),
    Buffer.from(source.toString('latin1').replace('http://127.0.0.1:3001/api/session', 'http://127.0.0.1:8081/api/session'), 'latin1'),
  );
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);

  await fs.rename(output, input);
  await run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output]);
  assert.deepEqual(await fs.readFile(output), await fs.readFile(input));
});

test('Push Lab session cutover fails closed for an unexpected or duplicate URL', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-push-env-invalid-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const input = path.join(temporary, 'input.env');
  const output = path.join(temporary, 'output.env');
  await fs.writeFile(input, 'PUSH_LAB_TMS_SESSION_URL=https://example.invalid/api/session\n');
  await assert.rejects(
    run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output]),
    error => error.stderr.includes('unexpected PUSH_LAB_TMS_SESSION_URL'),
  );
  await fs.writeFile(input, 'PUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:3001/api/session\nPUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:3001/api/session\n');
  await assert.rejects(
    run(process.execPath, [path.join(DEPLOY, 'configure-push-session-url.mjs'), input, output]),
    error => error.stderr.includes('exactly one PUSH_LAB_TMS_SESSION_URL'),
  );
});

test('native rollout backs up Push Lab before stopping writers and changes it only after Kotlin health', async () => {
  const rollout = await fs.readFile(path.join(DEPLOY, 'rollout.sh'), 'utf8');
  const rollback = await fs.readFile(path.join(DEPLOY, 'rollback.sh'), 'utf8');
  const backup = rollout.indexOf('cp -a "$PUSH_ENV" "$BACKUP_DIR/config/push-lab-web.env"');
  const preflight = rollout.indexOf('configure-push-session-url.mjs');
  const cutover = rollout.indexOf('\nMUTATED=1\n');
  const kotlinHealth = rollout.indexOf('http://127.0.0.1:8081/actuator/health');
  const install = rollout.indexOf('install -m 0600 "$BACKUP_DIR/config/push-lab-web.env.candidate" "$PUSH_ENV"');
  assert.ok(backup >= 0 && backup < preflight && preflight < cutover);
  assert.ok(kotlinHealth > cutover && install > kotlinHealth);
  assert.match(rollout, /PUSH_WEB_SERVICE=meatbox-push-lab-web\.service/);
  assert.match(rollout, /systemctl restart "\$PUSH_WEB_SERVICE"/);
  assert.match(rollout, /cmp "\$PUSH_ENV" "\$BACKUP_DIR\/config\/push-lab-web\.env"/);
  assert.doesNotMatch(rollout, /push-lab-worker/);
  assert.match(rollback, /install -m 0600 "\$BACKUP_DIR\/config\/push-lab-web\.env" "\$PUSH_ENV"/);
  assert.match(rollback, /"\$BACKUP_DIR\/config\/\$PUSH_WEB_SERVICE\.active"/);
});
