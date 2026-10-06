#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MANIFEST_NAME = "MANIFEST.json";
const FORMAT = 1;
const CURRENT_FILES = ["server.js", "package.json", "package-lock.json", "lib/kotlin-access.js"];
const WEB_SCRIPTS = [
  "apps/web/scripts/serve-legacy.mjs",
  "apps/web/scripts/legacy-gateway.mjs",
  "apps/web/scripts/api-routing.mjs",
];
const LEGACY_ROOTS = [
  "lib",
  "apps/combined",
  "apps/portal",
  "workspaces/jiin-ui",
  "workspaces/sanghyun-scenario/public",
  "workspaces/sanghyun-scenario/src",
];
const DIRTY_SCOPE = [...CURRENT_FILES, ...WEB_SCRIPTS, ...LEGACY_ROOTS, "apps/web", "services/api", "deploy/new-stack"];
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "test",
  "tests",
  "dispatch-data",
  "dispatch-state",
]);
const FORBIDDEN_BASENAMES = new Set([
  "access.json",
  "resources.sqlite",
  "resources.sqlite-shm",
  "resources.sqlite-wal",
]);
const SECRET_NAME = /(?:^|[._-])(?:credential|credentials|secret|secrets|password|private[-_]?key)(?:[._-]|$)/i;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizeReleasePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error(`unsafe release path: ${String(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe release path: ${value}`);
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") throw new Error(`unsafe release path: ${value}`);
    if (FORBIDDEN_SEGMENTS.has(segment)) throw new Error(`forbidden release path: ${value}`);
    if (segment.startsWith(".") && value !== "web/.runtime/dist" && !value.startsWith("web/.runtime/dist/")) {
      throw new Error(`hidden release path is not allowed: ${value}`);
    }
  }
  const basename = segments.at(-1).toLowerCase();
  if (FORBIDDEN_BASENAMES.has(basename) || basename.endsWith(".env") || basename.endsWith(".pem")
    || basename.endsWith(".key") || SECRET_NAME.test(basename)) {
    throw new Error(`secret or runtime data path is not allowed: ${value}`);
  }
  return value;
}

async function runGit(root, args, encoding = "utf8") {
  const result = await execFile("git", ["-C", root, ...args], { encoding, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

async function gitHead(root, ref) {
  return (await runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

async function dirtyState(root) {
  const repository = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const selected = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...DIRTY_SCOPE]);
  return {
    dirty: repository.split("\n").some(Boolean),
    scope: DIRTY_SCOPE,
    entries: selected.split("\n").filter(Boolean).sort(),
  };
}

async function legacyFiles(root) {
  const files = [];
  for (const sourceRoot of LEGACY_ROOTS) {
    const absolute = path.resolve(root, sourceRoot);
    const rootStat = await fs.lstat(absolute).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!rootStat) continue;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`legacy source root is unsafe: ${absolute}`);
    for (const relative of await regularFiles(absolute)) {
      const source = `${sourceRoot}/${relative}`;
      if (CURRENT_FILES.includes(source) || /\.test\.(?:js|mjs|cjs|ts)$/.test(source)) continue;
      const stat = await fs.lstat(path.join(absolute, ...relative.split("/")));
      files.push({ source, destination: `legacy/${source}`, executable: (stat.mode & 0o111) !== 0 });
    }
  }
  return files.sort((a, b) => a.destination.localeCompare(b.destination));
}

async function regularFiles(root, { skipDirectories = new Set() } = {}) {
  const files = [];
  async function visit(directory, relative = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && skipDirectories.has(childRelative)) continue;
      if (entry.isSymbolicLink()) throw new Error(`source symlink is not allowed: ${child}`);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) files.push(childRelative);
      else throw new Error(`unsupported source file: ${child}`);
    }
  }
  await visit(root);
  return files;
}

async function assertRegularFile(filename, label) {
  let stat;
  try { stat = await fs.lstat(filename); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${filename}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${filename}`);
  return stat;
}

async function writeArtifact(staging, destination, bytes, executable = false) {
  const safe = normalizeReleasePath(destination);
  const filename = path.join(staging, ...safe.split("/"));
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
  await fs.writeFile(filename, bytes, { mode: executable ? 0o755 : 0o644, flag: "wx" });
  await fs.chmod(filename, executable ? 0o755 : 0o644);
  return { path: safe, sha256: sha256(bytes), size: bytes.length, mode: executable ? "0755" : "0644" };
}

async function copyLocalFile(root, staging, source, destination, executable = false) {
  const filename = path.resolve(root, source);
  if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`source escapes repository: ${source}`);
  await assertRegularFile(filename, source);
  return writeArtifact(staging, destination, await fs.readFile(filename), executable);
}

async function resolveApiJar(root, explicit) {
  if (explicit) {
    await assertRegularFile(explicit, "API JAR");
    if (!explicit.endsWith(".jar") || explicit.endsWith("-plain.jar")) throw new Error(`API JAR is not an executable Spring Boot JAR: ${explicit}`);
    return path.resolve(explicit);
  }
  const directory = path.join(root, "services/api/build/libs");
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`API build output is missing: ${directory}`);
    throw error;
  }
  const candidates = entries.filter(entry => entry.isFile() && entry.name.endsWith(".jar") && !entry.name.endsWith("-plain.jar"));
  if (candidates.length !== 1) throw new Error(`expected exactly one executable API JAR in ${directory}, found ${candidates.length}`);
  const result = path.join(directory, candidates[0].name);
  await assertRegularFile(result, "API JAR");
  return result;
}

async function copyTree(root, staging, sourceRoot, destinationRoot) {
  const absolute = path.resolve(root, sourceRoot);
  const stat = await fs.lstat(absolute).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`build directory is missing or unsafe: ${absolute}`);
  const artifacts = [];
  for (const relative of await regularFiles(absolute)) {
    const stat = await fs.lstat(path.join(absolute, ...relative.split("/")));
    artifacts.push(await copyLocalFile(
      root,
      staging,
      `${sourceRoot}/${relative}`,
      `${destinationRoot}/${relative}`,
      (stat.mode & 0o111) !== 0,
    ));
  }
  if (!artifacts.length) throw new Error(`build directory is empty: ${absolute}`);
  return artifacts;
}

async function createArchive(releaseDirectory, archivePath) {
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.access(archivePath).then(() => { throw new Error(`release archive already exists: ${archivePath}`); }, error => {
    if (error.code !== "ENOENT") throw error;
  });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-czf", archivePath, "-C", path.dirname(releaseDirectory), path.basename(releaseDirectory)], {
        stdio: "inherit",
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
    });
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    throw error;
  }
}

export async function verifyRelease(releaseDirectory, { allowInstalledDependencies = false } = {}) {
  const root = path.resolve(releaseDirectory);
  const rootStat = await fs.lstat(root).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`release directory is missing or unsafe: ${root}`);
  const manifestPath = path.join(root, MANIFEST_NAME);
  await assertRegularFile(manifestPath, "release manifest");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.artifacts) || typeof manifest.releaseId !== "string") {
    throw new Error("unrecognized release manifest");
  }
  const expected = new Map();
  for (const artifact of manifest.artifacts) {
    const safe = normalizeReleasePath(artifact.path);
    if (expected.has(safe) || !/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 0
      || !["0644", "0755"].includes(artifact.mode)) {
      throw new Error(`invalid manifest artifact: ${safe}`);
    }
    expected.set(safe, artifact);
    const filename = path.join(root, ...safe.split("/"));
    const stat = await assertRegularFile(filename, `release artifact ${safe}`);
    if ((stat.mode & 0o7777) !== Number.parseInt(artifact.mode, 8)) throw new Error(`release artifact mode mismatch: ${safe}`);
    const bytes = await fs.readFile(filename);
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error(`release artifact hash mismatch: ${safe}`);
  }
  const skipDirectories = allowInstalledDependencies ? new Set(["legacy/node_modules"]) : new Set();
  const actual = (await regularFiles(root, { skipDirectories })).filter(filename => filename !== MANIFEST_NAME).map(normalizeReleasePath).sort();
  const expectedPaths = [...expected.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) throw new Error("release contains unrecognized or missing files");
  const calculated = sha256(Buffer.from(stableJson({ git: manifest.git, artifacts: manifest.artifacts }))).slice(0, 16);
  if (manifest.releaseId !== `${manifest.git.head.slice(0, 12)}-${calculated}`) throw new Error("release identifier does not match manifest content");
  return manifest;
}

export async function buildRelease({
  root = DEFAULT_ROOT,
  output,
  legacyRef = "HEAD",
  apiJar,
  archive = false,
} = {}) {
  root = path.resolve(root);
  const legacyBaseline = await gitHead(root, legacyRef);
  const currentHead = await gitHead(root, "HEAD");
  const dirty = await dirtyState(root);
  const resolvedApiJar = await resolveApiJar(root, apiJar);
  const releaseRoot = path.join(root, ".runtime/new-stack-release");
  await fs.mkdir(releaseRoot, { recursive: true, mode: 0o755 });
  const staging = await fs.mkdtemp(path.join(releaseRoot, ".stage-"));
  const artifacts = [];
  try {
    for (const entry of await legacyFiles(root)) {
      artifacts.push(await copyLocalFile(root, staging, entry.source, entry.destination, entry.executable));
    }
    for (const source of CURRENT_FILES) artifacts.push(await copyLocalFile(root, staging, source, `legacy/${source}`));
    for (const source of WEB_SCRIPTS) artifacts.push(await copyLocalFile(root, staging, source, `web/scripts/${path.basename(source)}`));
    artifacts.push(...await copyTree(root, staging, "apps/web/.runtime/dist", "web/.runtime/dist"));
    artifacts.push(await writeArtifact(staging, "api/meatbox-api.jar", await fs.readFile(resolvedApiJar)));
    artifacts.push(...await copyTree(root, staging, "deploy/new-stack", "deploy/new-stack"));
    artifacts.push(await writeArtifact(staging, "tools/package-new-stack.mjs", await fs.readFile(SCRIPT_PATH), true));
    artifacts.push(await writeArtifact(staging, "REVISION", Buffer.from(`${currentHead}\n`)));
    artifacts.sort((a, b) => a.path.localeCompare(b.path));
    const git = {
      head: currentHead,
      legacyRef: legacyBaseline,
      legacySource: "working-tree",
      dirty: dirty.dirty,
      dirtyScope: dirty.scope,
      dirtyEntries: dirty.entries,
    };
    const digest = sha256(Buffer.from(stableJson({ git, artifacts }))).slice(0, 16);
    const releaseId = `${currentHead.slice(0, 12)}-${digest}`;
    const manifest = { format: FORMAT, releaseId, git, artifacts };
    await fs.writeFile(path.join(staging, MANIFEST_NAME), stableJson(manifest), { mode: 0o644, flag: "wx" });
    const destination = path.resolve(output || path.join(releaseRoot, releaseId));
    if (destination === root || !destination.startsWith(`${root}${path.sep}`)) throw new Error("release output must stay inside the repository");
    await fs.access(destination).then(() => { throw new Error(`release output already exists: ${destination}`); }, error => {
      if (error.code !== "ENOENT") throw error;
    });
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await fs.rename(staging, destination);
    await verifyRelease(destination);
    const archivePath = archive ? `${destination}.tar.gz` : null;
    if (archivePath) await createArchive(destination, archivePath);
    return { directory: destination, archive: archivePath, manifest };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--archive") options.archive = true;
    else if (["--output", "--legacy-ref", "--api-jar", "--verify", "--verify-installed"].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.verifyInstalled) {
    const manifest = await verifyRelease(options.verifyInstalled, { allowInstalledDependencies: true });
    process.stdout.write(`${JSON.stringify({ status: "verified", directory: path.resolve(options.verifyInstalled), releaseId: manifest.releaseId, installedDependencies: true })}\n`);
    return;
  }
  if (options.verify) {
    const manifest = await verifyRelease(options.verify);
    process.stdout.write(`${JSON.stringify({ status: "verified", directory: path.resolve(options.verify), releaseId: manifest.releaseId })}\n`);
    return;
  }
  const result = await buildRelease(options);
  process.stdout.write(`${JSON.stringify({ status: "packaged", directory: result.directory, archive: result.archive, releaseId: result.manifest.releaseId })}\n`);
}

const invokedScript = process.argv[1]
  ? await fs.realpath(path.resolve(process.argv[1])).catch(() => null)
  : null;
if (invokedScript === await fs.realpath(SCRIPT_PATH)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
