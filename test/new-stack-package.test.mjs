import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildRelease, verifyRelease } from "../scripts/package-new-stack.mjs";

const execFile = promisify(execFileCallback);

async function write(root, relative, contents, mode = 0o644) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents, { mode });
  await fs.chmod(filename, mode);
}

async function git(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { encoding: "buffer" })).stdout;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meatbox-release-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracked = new Map([
    ["server.js", "module.exports = 'head';\n"],
    ["package.json", "{\"name\":\"fixture\",\"version\":\"1.0.0\"}\n"],
    ["package-lock.json", "{\"name\":\"fixture\",\"lockfileVersion\":3}\n"],
    ["lib/access.js", "module.exports = 'tracked access';\n"],
    ["apps/combined/index.html", "<main>tracked combined demo</main>\n"],
    ["apps/combined/dispatch-assignment.mjs", "export const dispatchModel = 'tracked';\n"],
    ["apps/combined/delivery-bundles.mjs", "export const destinationModel = 'tracked';\n"],
    ["apps/combined/state-frames.mjs", "export const stateFrames = 'tracked';\n"],
    ["apps/combined/simulation-adapter.mjs", "export const simulationAdapter = 'tracked';\n"],
    ["apps/portal/pages.js", "module.exports = 'tracked portal';\n"],
    ["workspaces/jiin-ui/index.html", "<main>tracked ui</main>\n"],
    ["workspaces/sanghyun-scenario/public/index.html", "<main>tracked scenario</main>\n"],
    ["workspaces/sanghyun-scenario/src/route-data.js", "module.exports = [];\n"],
  ]);
  for (const [relative, contents] of tracked) await write(root, relative, contents);
  await execFile("git", ["init", "-q", root]);
  await git(root, "config", "user.name", "Package Test");
  await git(root, "config", "user.email", "package-test@example.invalid");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "fixture head");

  await write(root, "server.js", [
    "const access = require('./lib/access');",
    "const routeData = require('./workspaces/sanghyun-scenario/src/route-data');",
    "Promise.all([",
    "  import('./apps/combined/dispatch-assignment.mjs'),",
    "  import('./apps/combined/delivery-bundles.mjs'),",
    "]).then(models => console.log(access, routeData.length, models.length));",
    "",
  ].join("\n"));
  await write(root, "lib/access.js", "module.exports = 'current access';\n");
  await write(root, "lib/kotlin-access.js", "module.exports = 'current session bridge';\n");
  await write(root, "package.json", "{\"name\":\"fixture\",\"version\":\"2.0.0\"}\n");
  await write(root, "package-lock.json", "{\"name\":\"fixture\",\"lockfileVersion\":3,\"packages\":{}}\n");
  for (const script of ["serve-legacy.mjs", "legacy-gateway.mjs", "api-routing.mjs"]) {
    await write(root, `apps/web/scripts/${script}`, `export const name = ${JSON.stringify(script)};\n`);
  }
  await write(root, "apps/web/combined/app.mjs", "export const currentFrontend = true;\n");
  await write(root, "services/api/src/main/kotlin/Fixture.kt", "class Fixture\n");
  await write(root, "apps/web/.runtime/dist/combined/index.html", "<main>built web</main>\n");
  await write(root, "services/api/build/libs/meatbox-api-1.0.jar", "executable jar fixture\n");
  await write(root, "deploy/new-stack/meatbox-api.service", "[Service]\nExecStart=/usr/bin/true\n");
  await write(root, "deploy/new-stack/rollout.sh", "#!/bin/sh\nexit 0\n", 0o755);
  await fs.rm(path.join(root, "apps/combined/index.html"));
  await fs.rm(path.join(root, "workspaces/jiin-ui"), { recursive: true });
  await fs.rm(path.join(root, "workspaces/sanghyun-scenario/public"), { recursive: true });
  return root;
}

test("new-stack package is immutable, source-bounded, and self-verifying", async t => {
  const root = await fixture(t);
  const output = path.join(root, ".runtime/new-stack-release/test-release");
  const result = await buildRelease({ root, output, archive: true });
  const manifest = await verifyRelease(output);
  const paths = new Set(manifest.artifacts.map(artifact => artifact.path));

  assert.equal(manifest.git.head, (await git(root, "rev-parse", "HEAD")).toString("utf8").trim());
  assert.equal(manifest.git.legacyRef, manifest.git.head);
  assert.equal(manifest.git.legacySource, "working-tree");
  assert.equal(manifest.git.dirty, true);
  assert.ok(manifest.git.dirtyEntries.some(entry => entry.endsWith(" server.js")));
  assert.ok(manifest.git.dirtyEntries.some(entry => entry.endsWith(" apps/combined/index.html")));
  assert.ok(manifest.git.dirtyEntries.some(entry => entry.endsWith(" workspaces/jiin-ui/index.html")));
  assert.ok(manifest.git.dirtyEntries.some(entry => entry.endsWith(" apps/web/combined/app.mjs")));
  assert.ok(manifest.git.dirtyEntries.some(entry => entry.endsWith(" services/api/src/main/kotlin/Fixture.kt")));
  assert.equal(result.manifest.releaseId, manifest.releaseId);
  const archiveEntries = (await execFile("tar", ["-tzf", result.archive], { encoding: "utf8" })).stdout.split("\n");
  assert.ok(!archiveEntries.some(entry => entry.split("/").some(segment => segment.startsWith("._"))));
  const extracted = path.join(root, ".runtime/extracted");
  await fs.mkdir(extracted);
  await execFile("tar", ["-xzf", result.archive, "-C", extracted]);
  assert.deepEqual(await verifyRelease(path.join(extracted, path.basename(output))), manifest);

  assert.ok(paths.has("legacy/server.js"));
  assert.ok(paths.has("legacy/lib/access.js"));
  assert.ok(paths.has("legacy/apps/combined/dispatch-assignment.mjs"));
  assert.ok(paths.has("legacy/apps/combined/delivery-bundles.mjs"));
  assert.ok(paths.has("legacy/apps/combined/state-frames.mjs"));
  assert.ok(paths.has("legacy/apps/combined/simulation-adapter.mjs"));
  assert.ok(paths.has("legacy/workspaces/sanghyun-scenario/src/route-data.js"));
  assert.ok(!paths.has("legacy/apps/combined/index.html"));
  assert.ok(![...paths].some(filename => filename.startsWith("legacy/workspaces/jiin-ui/")));
  assert.ok(![...paths].some(filename => filename.startsWith("legacy/workspaces/sanghyun-scenario/public/")));
  assert.ok(paths.has("web/.runtime/dist/combined/index.html"));
  assert.ok(paths.has("web/scripts/api-routing.mjs"));
  assert.ok(paths.has("api/meatbox-api.jar"));
  assert.ok(paths.has("deploy/new-stack/meatbox-api.service"));
  assert.ok(paths.has("tools/package-new-stack.mjs"));
  assert.ok(![...paths].some(filename => /(?:^|\/)(?:node_modules|test|tests|dispatch-state|\.git)(?:\/|$)/.test(filename)));
  assert.ok(![...paths].some(filename => /(?:access\.json|resources\.sqlite|\.pem|\.key)$/i.test(filename)));

  assert.deepEqual(await fs.readFile(path.join(output, "legacy/lib/access.js")), await fs.readFile(path.join(root, "lib/access.js")));
  assert.notDeepEqual(await fs.readFile(path.join(output, "legacy/lib/access.js")), await git(root, "show", `${manifest.git.legacyRef}:lib/access.js`));
  assert.deepEqual(await fs.readFile(path.join(output, "legacy/server.js")), await fs.readFile(path.join(root, "server.js")));
  assert.equal((await fs.stat(path.join(output, "deploy/new-stack/rollout.sh"))).mode & 0o777, 0o755);
  const packagedServer = await execFile(process.execPath, [path.join(output, "legacy/server.js")], { encoding: "utf8" });
  assert.equal(packagedServer.stdout, "current access 0 2\n");

  await t.test("the packaged verifier runs through a script symlink and still rejects corruption", async () => {
    const verifierLink = path.join(root, ".runtime/package-new-stack-link.mjs");
    await fs.symlink(path.join(output, "tools/package-new-stack.mjs"), verifierLink);
    const verified = await execFile(process.execPath, [verifierLink, "--verify-installed", output], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(verified.stdout), {
      status: "verified",
      directory: output,
      releaseId: manifest.releaseId,
      installedDependencies: true,
    });

    const filename = path.join(output, "legacy/package.json");
    const original = await fs.readFile(filename);
    await fs.writeFile(filename, Buffer.concat([original, Buffer.from("\ncorrupt")]));
    await assert.rejects(
      execFile(process.execPath, [verifierLink, "--verify-installed", output], { encoding: "utf8" }),
      error => error.code !== 0 && /hash mismatch/.test(error.stderr),
    );
    await fs.writeFile(filename, original);
    await verifyRelease(output);

    const releaseLink = path.join(root, ".runtime/release-link");
    await fs.symlink(output, releaseLink);
    await assert.rejects(verifyRelease(releaseLink), /release directory is missing or unsafe/);
  });

  await t.test("a changed artifact is rejected", async () => {
    const filename = path.join(output, "legacy/package.json");
    const original = await fs.readFile(filename);
    await fs.writeFile(filename, Buffer.concat([original, Buffer.from("\n")]));
    await assert.rejects(verifyRelease(output), /hash mismatch/);
    await fs.writeFile(filename, original);
    await verifyRelease(output);
  });

  await t.test("a missing artifact is rejected", async () => {
    const filename = path.join(output, "web/scripts/api-routing.mjs");
    const original = await fs.readFile(filename);
    await fs.rm(filename);
    await assert.rejects(verifyRelease(output), /missing/);
    await fs.writeFile(filename, original, { mode: 0o644 });
    await verifyRelease(output);
  });

  await t.test("stripped executable permissions are rejected", async () => {
    const filename = path.join(output, "deploy/new-stack/rollout.sh");
    await fs.chmod(filename, 0o644);
    await assert.rejects(verifyRelease(output), /mode mismatch/);
    await fs.chmod(filename, 0o755);
    await verifyRelease(output);
  });

  await t.test("widened artifact permissions are rejected", async () => {
    const filename = path.join(output, "legacy/package.json");
    await fs.chmod(filename, 0o666);
    await assert.rejects(verifyRelease(output), /mode mismatch/);
    await fs.chmod(filename, 0o644);
    await verifyRelease(output);
  });

  await t.test("unsupported manifest permissions are rejected", async () => {
    const filename = path.join(output, "MANIFEST.json");
    const original = await fs.readFile(filename);
    const changed = JSON.parse(original);
    changed.artifacts[0].mode = "0777";
    await fs.writeFile(filename, `${JSON.stringify(changed)}\n`);
    await assert.rejects(verifyRelease(output), /invalid manifest artifact/);
    await fs.writeFile(filename, original);
    await verifyRelease(output);
  });

  await t.test("an undeclared secret path is rejected", async () => {
    const filename = path.join(output, "legacy/access.json");
    await fs.writeFile(filename, "{}\n", { mode: 0o600 });
    await assert.rejects(verifyRelease(output), /secret or runtime data path/);
    await fs.rm(filename);
    await verifyRelease(output);
  });

  await t.test("installed dependencies are accepted only by the reapply verifier", async () => {
    const filename = path.join(output, "legacy/node_modules/example/index.js");
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, "module.exports = true;\n", { mode: 0o644 });
    await assert.rejects(verifyRelease(output), /forbidden release path/);
    await verifyRelease(output, { allowInstalledDependencies: true });
    await fs.rm(path.join(output, "legacy/node_modules"), { recursive: true });
    await verifyRelease(output);
  });
});

test("packaging fails before output when the executable API artifact is missing", async t => {
  const root = await fixture(t);
  const output = path.join(root, ".runtime/new-stack-release/missing-api");
  await assert.rejects(
    buildRelease({ root, output, apiJar: path.join(root, "services/api/build/libs/missing.jar") }),
    /API JAR is missing/,
  );
  await assert.rejects(fs.access(output), error => error.code === "ENOENT");
});
