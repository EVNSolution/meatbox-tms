#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const EXPECTED_WORKFLOW = '.github/workflows/new-stack.yml';
const EXPECTED_WORKFLOW_NAME = 'New stack checks';
const EXPECTED_ARTIFACT = 'meatbox-test-release';
const EXPECTED_OWNER_ID = 267003080;
const EXPECTED_REPOSITORY_ID = 1368015789;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shaPattern = /^[0-9a-f]{40}$/;
const releasePattern = /^[0-9a-f]{12}-[0-9a-f]{16}$/;

function fail(message) {
  throw new Error(message);
}

async function api(repository, token, route) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'meatbox-ci-artifact-verifier',
    },
  });
  if (!response.ok) fail(`GitHub API ${route} returned ${response.status}`);
  return response.json();
}

export async function validateRun({ repository, token, runId, trigger }) {
  if (!repository || !token || !/^\d+$/.test(String(runId))) fail('repository, token and numeric run ID are required');
  if (!['auto', 'manual'].includes(trigger)) fail('trigger must be auto or manual');
  const [run, repo] = await Promise.all([
    api(repository, token, `/actions/runs/${runId}`),
    api(repository, token, ''),
  ]);
  if (repo.id !== EXPECTED_REPOSITORY_ID || repo.owner?.id !== EXPECTED_OWNER_ID || repo.full_name !== repository) {
    fail('repository identity does not match the reviewed immutable repository IDs');
  }
  if (run.repository?.id !== EXPECTED_REPOSITORY_ID || run.repository?.owner?.id !== EXPECTED_OWNER_ID
    || run.head_repository?.id !== EXPECTED_REPOSITORY_ID || run.head_repository?.owner?.id !== EXPECTED_OWNER_ID) {
    fail('workflow run repository IDs do not match the reviewed repository');
  }
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) fail('workflow run is not from this repository');
  if (run.name !== EXPECTED_WORKFLOW_NAME || run.path !== EXPECTED_WORKFLOW) fail('workflow run does not use the reviewed verification workflow');
  if (run.status !== 'completed' || run.conclusion !== 'success') fail('workflow run is not successfully completed');
  if (!shaPattern.test(run.head_sha)) fail('workflow run head SHA is invalid');
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) fail('workflow run attempt is invalid');
  const artifactPage = await api(repository, token, `/actions/runs/${runId}/artifacts?per_page=100`);
  const artifacts = artifactPage.artifacts?.filter(artifact => artifact.name === EXPECTED_ARTIFACT && !artifact.expired) ?? [];
  if (artifacts.length !== 1) fail('workflow run must have exactly one unexpired TEST release artifact');
  const artifact = artifacts[0];
  if (artifact.workflow_run?.id !== run.id || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1
    || !artifact.expires_at || Date.parse(artifact.expires_at) <= Date.now()) {
    fail('TEST release artifact API identity or digest is invalid');
  }
  const defaultBranch = repo.default_branch;
  if (!defaultBranch) fail('repository default branch is unavailable');

  if (run.event === 'push') {
    if (run.head_branch !== defaultBranch) fail('push run is not from the default branch');
    const ref = await api(repository, token, `/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
    if (ref.object?.sha !== run.head_sha) fail('workflow run is stale against the current default branch');
    return { run, artifact, source: { kind: 'main', sha: run.head_sha, defaultBranch } };
  }

  if (run.event !== 'pull_request' || trigger !== 'manual') fail('only manual deployment may select a pull request run');
  const references = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (references.length !== 1 || !Number.isSafeInteger(references[0].number)) fail('workflow run must identify exactly one pull request');
  const pull = await api(repository, token, `/pulls/${references[0].number}`);
  if (pull.state !== 'open' || pull.head?.repo?.full_name !== repository) fail('pull request is closed or from an untrusted fork');
  if (pull.head.sha !== run.head_sha) fail('workflow run is stale against the current pull request head');
  if (!shaPattern.test(pull.merge_commit_sha)) fail('pull request merge revision is unavailable');
  const mergeRef = await api(repository, token, `/git/ref/pull/${pull.number}/merge`);
  if (mergeRef.object?.sha !== pull.merge_commit_sha) fail('pull request merge revision is stale');
  return { run, artifact, source: { kind: 'pull_request', sha: run.head_sha, mergeSha: pull.merge_commit_sha, number: pull.number, defaultBranch } };
}

function assertPlainBasename(value, suffix) {
  if (typeof value !== 'string' || path.basename(value) !== value || value === '.' || value === '..' || !value.endsWith(suffix)) {
    fail(`unsafe artifact filename: ${String(value)}`);
  }
}

async function regularFile(filename, label) {
  const stat = await fs.lstat(filename).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
}

async function regularFiles(root) {
  const files = [];
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`reviewed tool path is a symlink: ${next}`);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), next);
      else if (entry.isFile()) files.push(next);
      else fail(`reviewed tool path is not regular: ${next}`);
    }
  }
  await visit(root);
  return files;
}

async function compareReviewedTools(releaseDirectory, reviewedRoot) {
  const reviewedDeploy = path.join(reviewedRoot, 'deploy/new-stack');
  const candidateDeploy = path.join(releaseDirectory, 'deploy/new-stack');
  const reviewedFiles = await regularFiles(reviewedDeploy);
  const candidateFiles = await regularFiles(candidateDeploy);
  if (JSON.stringify(candidateFiles) !== JSON.stringify(reviewedFiles)) fail('release deployment tools differ from the reviewed default-branch checkout');
  for (const filename of reviewedFiles) {
    const [reviewed, candidate] = await Promise.all([
      fs.readFile(path.join(reviewedDeploy, filename)),
      fs.readFile(path.join(candidateDeploy, filename)),
    ]);
    if (!reviewed.equals(candidate)) fail(`release deployment tool differs from reviewed checkout: ${filename}`);
  }
  const [reviewedPackager, candidatePackager] = await Promise.all([
    fs.readFile(path.join(reviewedRoot, 'scripts/package-new-stack.mjs')),
    fs.readFile(path.join(releaseDirectory, 'tools/package-new-stack.mjs')),
  ]);
  if (!reviewedPackager.equals(candidatePackager)) fail('release verifier differs from the reviewed default-branch checkout');
}

export async function validateArtifactDirectory({ artifactDirectory, repository, run, source, reviewedRoot = REPOSITORY_ROOT }) {
  const root = path.resolve(artifactDirectory);
  const metadataPath = path.join(root, 'release-metadata.json');
  const sumsPath = path.join(root, 'SHA256SUMS');
  await regularFile(metadataPath, 'release metadata');
  await regularFile(sumsPath, 'checksum file');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  if (metadata.format !== 1 || metadata.artifactName !== EXPECTED_ARTIFACT) fail('release metadata format or artifact name is invalid');
  if (!releasePattern.test(metadata.releaseId)) fail('release ID is invalid');
  if (!shaPattern.test(metadata.git?.actualSha)) fail('release source SHA is invalid');
  if (metadata.github?.repository !== repository || String(metadata.github?.runId) !== String(run.id)) fail('release metadata does not match the selected workflow run');
  if (Number(metadata.github?.runAttempt) !== run.run_attempt) fail('release metadata does not match the selected workflow attempt');
  if (metadata.github?.event !== run.event) fail('release metadata event does not match the selected workflow run');
  if (source.kind === 'main') {
    if (metadata.git.actualSha !== source.sha || metadata.git.prHeadSha !== null) fail('default-branch release metadata is stale or ambiguous');
  } else if (metadata.git.prHeadSha !== source.sha || metadata.git.actualSha !== source.mergeSha) {
    fail('pull request release metadata does not match the current head and merge revision');
  }
  assertPlainBasename(metadata.archive, '.tar.gz');
  if (!/^[0-9a-f]{64}$/.test(metadata.archiveSha256)) fail('archive checksum is invalid');
  const archivePath = path.join(root, metadata.archive);
  await regularFile(archivePath, 'release archive');
  const actualSha = createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
  if (actualSha !== metadata.archiveSha256) fail('release archive checksum does not match metadata');
  const sums = await fs.readFile(sumsPath, 'utf8');
  if (sums !== `${metadata.archiveSha256}  ${metadata.archive}\n`) fail('SHA256SUMS does not exactly describe the selected archive');

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'meatbox-ci-release-'));
  try {
    const listing = await execFile('tar', ['-tvzf', archivePath]);
    for (const line of listing.stdout.trim().split('\n')) {
      if (!line) continue;
      if (!['-', 'd'].includes(line[0])) fail('release archive contains a link or special file');
      const filename = line.trim().split(/\s+/).at(-1)?.replace(/\/$/, '');
      if (filename !== metadata.releaseId && !filename?.startsWith(`${metadata.releaseId}/`)) fail('release archive path escapes its release directory');
    }
    await execFile('tar', ['-xzf', archivePath, '-C', temporary]);
    const releaseDirectory = path.join(temporary, metadata.releaseId);
    const entries = await fs.readdir(temporary);
    if (entries.length !== 1 || entries[0] !== metadata.releaseId) fail('release archive must contain exactly its release directory');
    await execFile(process.execPath, [path.join(reviewedRoot, 'scripts/package-new-stack.mjs'), '--verify', releaseDirectory]);
    await compareReviewedTools(releaseDirectory, reviewedRoot);
    const manifest = JSON.parse(await fs.readFile(path.join(releaseDirectory, 'MANIFEST.json'), 'utf8'));
    const revision = (await fs.readFile(path.join(releaseDirectory, 'REVISION'), 'utf8')).trim();
    if (manifest.releaseId !== metadata.releaseId || manifest.git?.head !== metadata.git.actualSha || revision !== metadata.git.actualSha) {
      fail('release manifest, revision and metadata disagree');
    }
    if (manifest.git?.dirty !== false || manifest.git?.dirtyEntries?.length) fail('CI release contains dirty source state');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return { metadata, archivePath };
}

export async function validateInstalledNoop({ installedRoot, modeFile, releaseId, sourceSha, reviewedVerifier }) {
  if (!releasePattern.test(releaseId) || !shaPattern.test(sourceSha)) fail('expected installed release identity is invalid');
  await regularFile(modeFile, 'deployment mode');
  const mode = (await fs.readFile(modeFile, 'utf8')).trim();
  if (mode !== `native ${releaseId}`) fail('installed deployment mode does not match the no-op candidate');
  const releases = path.join(installedRoot, 'releases');
  const current = path.join(installedRoot, 'current');
  const currentStat = await fs.lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!currentStat?.isSymbolicLink()) fail('installed current pointer is not a symlink');
  const target = await fs.realpath(current);
  const expectedTarget = path.join(await fs.realpath(releases), releaseId);
  if (target !== expectedTarget) fail('installed current pointer does not match the no-op candidate');
  await execFile(process.execPath, [reviewedVerifier, '--verify-installed', target]);
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'MANIFEST.json'), 'utf8'));
  const revision = (await fs.readFile(path.join(target, 'REVISION'), 'utf8')).trim();
  if (manifest.releaseId !== releaseId || manifest.git?.head !== sourceSha || revision !== sourceSha) {
    fail('installed manifest does not match the no-op candidate');
  }
  return { releaseId, sourceSha, target };
}

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) fail('arguments must be --name value pairs');
    values[name.slice(2)] = value;
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  if (args['installed-root']) {
    const result = await validateInstalledNoop({
      installedRoot: args['installed-root'],
      modeFile: args['mode-file'],
      releaseId: args['expected-release-id'],
      sourceSha: args['expected-source-sha'],
      reviewedVerifier: args['reviewed-verifier'],
    });
    process.stdout.write(`${JSON.stringify({ status: 'installed-noop', ...result })}\n`);
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const trigger = args.trigger;
  if (trigger === 'manual' && process.env.GITHUB_REF_NAME !== process.env.GITHUB_DEFAULT_BRANCH) {
    fail('manual deployment workflow must run from the default branch');
  }
  const trusted = await validateRun({ repository, token, runId: args['run-id'], trigger });
  const artifact = await validateArtifactDirectory({
    artifactDirectory: args['artifact-dir'],
    repository,
    run: trusted.run,
    source: trusted.source,
  });
  const result = {
    format: 1,
    repository,
    runId: String(trusted.run.id),
    runAttempt: trusted.run.run_attempt,
    artifactId: trusted.artifact.id,
    artifactDigest: trusted.artifact.digest,
    source: trusted.source,
    releaseId: artifact.metadata.releaseId,
    sourceSha: artifact.metadata.git.actualSha,
    archive: path.resolve(artifact.archivePath),
    archiveSha256: artifact.metadata.archiveSha256,
  };
  await fs.writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: 'trusted', runId: result.runId, releaseId: result.releaseId, source: result.source })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
