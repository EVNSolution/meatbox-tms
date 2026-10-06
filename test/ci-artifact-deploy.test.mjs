import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateArtifactDirectory, validateInstalledNoop, validateRun } from '../deploy/new-stack/verify-ci-artifact.mjs';

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_VERIFIER = path.join(ROOT, 'scripts/package-new-stack.mjs');
const SHA = 'a'.repeat(40);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function artifactFixture(t, { event = 'push', prHeadSha = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-ci-artifact-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staging = path.join(root, 'staging');
  const verifier = await fs.readFile(SOURCE_VERIFIER);
  const rollout = Buffer.from('#!/bin/sh\nexit 0\n');
  const revision = Buffer.from(`${SHA}\n`);
  const artifacts = [
    { path: 'REVISION', sha256: hash(revision), size: revision.length, mode: '0644' },
    { path: 'deploy/new-stack/rollout.sh', sha256: hash(rollout), size: rollout.length, mode: '0755' },
    { path: 'tools/package-new-stack.mjs', sha256: hash(verifier), size: verifier.length, mode: '0755' },
  ];
  const git = { head: SHA, legacyRef: SHA, legacySource: 'working-tree', dirty: false, dirtyScope: [], dirtyEntries: [] };
  const releaseId = `${SHA.slice(0, 12)}-${hash(Buffer.from(stable({ git, artifacts }))).slice(0, 16)}`;
  const release = path.join(staging, releaseId);
  await fs.mkdir(path.join(release, 'deploy/new-stack'), { recursive: true });
  await fs.mkdir(path.join(release, 'tools'), { recursive: true });
  await fs.writeFile(path.join(release, 'REVISION'), revision, { mode: 0o644 });
  await fs.writeFile(path.join(release, 'deploy/new-stack/rollout.sh'), rollout, { mode: 0o755 });
  await fs.writeFile(path.join(release, 'tools/package-new-stack.mjs'), verifier, { mode: 0o755 });
  await fs.writeFile(path.join(release, 'MANIFEST.json'), stable({ format: 1, releaseId, git, artifacts }), { mode: 0o644 });
  const archiveName = `${releaseId}.tar.gz`;
  const artifact = path.join(root, 'artifact');
  await fs.mkdir(artifact);
  await execFile('tar', ['-czf', path.join(artifact, archiveName), '-C', staging, releaseId]);
  const archiveBytes = await fs.readFile(path.join(artifact, archiveName));
  const archiveSha256 = hash(archiveBytes);
  await fs.writeFile(path.join(artifact, 'SHA256SUMS'), `${archiveSha256}  ${archiveName}\n`);
  await fs.writeFile(path.join(artifact, 'release-metadata.json'), stable({
    format: 1,
    artifactName: 'meatbox-test-release',
    releaseId,
    archive: archiveName,
    archiveSha256,
    git: { actualSha: SHA, prHeadSha, ref: event === 'push' ? 'refs/heads/main' : 'refs/pull/35/merge' },
    github: { event, repository: 'EVNSolution/meatbox-tms', runId: '123', runAttempt: '1' },
  }));
  const reviewedRoot = path.join(root, 'reviewed');
  await fs.mkdir(path.join(reviewedRoot, 'deploy/new-stack'), { recursive: true });
  await fs.mkdir(path.join(reviewedRoot, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(reviewedRoot, 'deploy/new-stack/rollout.sh'), rollout, { mode: 0o755 });
  await fs.writeFile(path.join(reviewedRoot, 'scripts/package-new-stack.mjs'), verifier, { mode: 0o755 });
  return { artifact, releaseId, archiveName, reviewedRoot };
}

test('artifact validation binds checksum, clean manifest, source SHA and release ID', async t => {
  const fixture = await artifactFixture(t);
  const result = await validateArtifactDirectory({
    artifactDirectory: fixture.artifact,
    repository: 'EVNSolution/meatbox-tms',
    run: { id: 123, event: 'push', run_attempt: 1 },
    source: { kind: 'main', sha: SHA },
    reviewedRoot: fixture.reviewedRoot,
  });
  assert.equal(result.metadata.releaseId, fixture.releaseId);
  await fs.appendFile(path.join(fixture.artifact, fixture.archiveName), 'changed');
  await assert.rejects(
    validateArtifactDirectory({
      artifactDirectory: fixture.artifact,
      repository: 'EVNSolution/meatbox-tms',
      run: { id: 123, event: 'push', run_attempt: 1 },
      source: { kind: 'main', sha: SHA },
      reviewedRoot: fixture.reviewedRoot,
    }),
    /checksum does not match metadata/,
  );
});

test('run validation accepts current main and rejects a stale main run', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let current = SHA;
  globalThis.fetch = async url => {
    const route = new URL(url).pathname;
    const value = route.endsWith('/actions/runs/123')
      ? { id: 123, run_attempt: 1, name: 'New stack checks', path: '.github/workflows/new-stack.yml', status: 'completed', conclusion: 'success', event: 'push', head_sha: SHA, head_branch: 'main', repository: { id: 1368015789, full_name: 'EVNSolution/meatbox-tms', owner: { id: 267003080 } }, head_repository: { id: 1368015789, full_name: 'EVNSolution/meatbox-tms', owner: { id: 267003080 } } }
      : route.endsWith('/actions/runs/123/artifacts') ? { artifacts: [{ id: 9, name: 'meatbox-test-release', expired: false, expires_at: '2099-01-01T00:00:00Z', digest: `sha256:${'c'.repeat(64)}`, size_in_bytes: 10, workflow_run: { id: 123 } }] }
      : route.endsWith('/git/ref/heads/main') ? { object: { sha: current } }
        : { id: 1368015789, full_name: 'EVNSolution/meatbox-tms', owner: { id: 267003080 }, default_branch: 'main' };
    return { ok: true, json: async () => value };
  };
  assert.equal((await validateRun({ repository: 'EVNSolution/meatbox-tms', token: 'token', runId: '123', trigger: 'auto' })).source.kind, 'main');
  current = 'b'.repeat(40);
  await assert.rejects(validateRun({ repository: 'EVNSolution/meatbox-tms', token: 'token', runId: '123', trigger: 'auto' }), /stale/);
});

test('manual PR validation requires an open same-repository current head', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let headRepository = 'EVNSolution/meatbox-tms';
  let mergeRef = 'd'.repeat(40);
  globalThis.fetch = async url => {
    const route = new URL(url).pathname;
    const value = route.endsWith('/actions/runs/123')
      ? { id: 123, run_attempt: 1, name: 'New stack checks', path: '.github/workflows/new-stack.yml', status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: SHA, repository: { id: 1368015789, full_name: 'EVNSolution/meatbox-tms', owner: { id: 267003080 } }, head_repository: { id: 1368015789, full_name: 'EVNSolution/meatbox-tms', owner: { id: 267003080 } }, pull_requests: [{ number: 35 }] }
      : route.endsWith('/actions/runs/123/artifacts') ? { artifacts: [{ id: 9, name: 'meatbox-test-release', expired: false, expires_at: '2099-01-01T00:00:00Z', digest: `sha256:${'c'.repeat(64)}`, size_in_bytes: 10, workflow_run: { id: 123 } }] }
      : route.endsWith('/pulls/35') ? { number: 35, state: 'open', merge_commit_sha: 'd'.repeat(40), head: { sha: SHA, repo: { full_name: headRepository } } }
      : route.endsWith('/git/ref/pull/35/merge') ? { object: { sha: mergeRef } }
        : { id: 1368015789, full_name: 'EVNSolution/meatbox-tms', owner: { id: 267003080 }, default_branch: 'main' };
    return { ok: true, json: async () => value };
  };
  assert.equal((await validateRun({ repository: 'EVNSolution/meatbox-tms', token: 'token', runId: '123', trigger: 'manual' })).source.number, 35);
  headRepository = 'fork/meatbox-tms';
  await assert.rejects(validateRun({ repository: 'EVNSolution/meatbox-tms', token: 'token', runId: '123', trigger: 'manual' }), /untrusted fork/);
  headRepository = 'EVNSolution/meatbox-tms';
  mergeRef = 'e'.repeat(40);
  await assert.rejects(validateRun({ repository: 'EVNSolution/meatbox-tms', token: 'token', runId: '123', trigger: 'manual' }), /merge revision is stale/);
});

test('installed no-op validation requires exact native mode, current target and source manifest', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-noop-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseId = `${SHA.slice(0, 12)}-${'1'.repeat(16)}`;
  const releases = path.join(root, 'releases');
  const release = path.join(releases, releaseId);
  const modeFile = path.join(root, 'deployment-mode');
  const verifier = path.join(root, 'reviewed-verifier.mjs');
  await fs.mkdir(release, { recursive: true });
  await fs.writeFile(path.join(release, 'MANIFEST.json'), stable({ releaseId, git: { head: SHA } }));
  await fs.writeFile(path.join(release, 'REVISION'), `${SHA}\n`);
  await fs.writeFile(modeFile, `native ${releaseId}\n`);
  await fs.writeFile(verifier, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  await fs.symlink(release, path.join(root, 'current'));
  assert.equal((await validateInstalledNoop({ installedRoot: root, modeFile, releaseId, sourceSha: SHA, reviewedVerifier: verifier })).releaseId, releaseId);
  await fs.writeFile(modeFile, `native ${SHA.slice(0, 12)}-${'2'.repeat(16)}\n`);
  await assert.rejects(validateInstalledNoop({ installedRoot: root, modeFile, releaseId, sourceSha: SHA, reviewedVerifier: verifier }), /mode does not match/);
});

test('deploy workflow has one serialized artifact-only TEST lane', async () => {
  const workflow = await fs.readFile(path.join(ROOT, '.github/workflows/deploy-test.yml'), 'utf8');
  assert.match(workflow, /group: meatbox-test-deploy/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(workflow, /environment: test/);
  assert.match(workflow, /Recheck run freshness and artifact identity[\s\S]+Configure TEST AWS identity/);
  assert.doesNotMatch(workflow, /npm ci|gradlew|vite|make check|package-new-stack\.mjs --archive/);
});

test('deploy wrapper uses an SSH control option valid for both ssh and scp', async () => {
  const wrapper = await fs.readFile(path.join(ROOT, 'deploy/new-stack/deploy-ci-artifact.sh'), 'utf8');
  assert.match(wrapper, /-o ControlPath="\$CONTROL_PATH"/);
  assert.doesNotMatch(wrapper, /SSH_ARGS=\(-S/);
});

test('deploy wrapper creates a master that accepts unattended SSH sessions', async () => {
  const wrapper = await fs.readFile(path.join(ROOT, 'deploy/new-stack/deploy-ci-artifact.sh'), 'utf8');
  const masterCommand = wrapper.split('\n').find(line => line.includes('-o ControlMaster=yes'));
  assert.ok(masterCommand, 'wrapper must define its own SSH master');
  const { stdout } = await execFile('bash', ['-c', `
    SSH_ARGS=(-F /dev/null)
    CONTROL_PATH=/tmp/meatbox-master-config-test
    TEST_USER=ubuntu
    TEST_HOST=127.0.0.1
    ${masterCommand.trim().replace(/^ssh /, 'ssh -G ')}
  `]);
  const controlMaster = stdout.split('\n').find(line => line.startsWith('controlmaster '));
  assert.equal(controlMaster, 'controlmaster true');
});
