import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { createLegacyGateway } from "../scripts/legacy-gateway.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixtureDist() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meatbox-web-gateway-"));
  temporaryDirectories.push(directory);
  const files = {
    "login/index.html": "<h1>login</h1>",
    "dev/register/index.html": "<h1>register</h1>",
    "portal.css": "@import '/theme.css'; body { color: #111; }",
    "components.css": ".button { min-height: 44px; }",
    "theme.css": "@font-face { font-family: Pretendard; src: url('/portal-font.ttf'); }",
    "portal-logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
    "portal-font.ttf": "font",
    "portal-validation.js": "export const valid = true;",
    "portal-auth.js": "export const auth = true;",
    "combined/index.html": "<h1>combined</h1>",
    "combined/app.mjs": "export const app = true;",
    "combined/style.css": "body { color: #222; }",
    "ui-layout/index.html": "<h1>layout</h1>",
  };
  await Promise.all(Object.entries(files).map(async ([name, body]) => {
    const filename = path.join(directory, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, body);
  }));
  return directory;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function unusedOrigin() {
  const server = http.createServer();
  const origin = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return origin;
}

function requestRaw(origin, url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      method: options.method || "GET",
      path: url,
      headers: options.headers,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function createFixtureApi() {
  const seen = [];
  let sessionMode = "normal";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, origin: req.headers.origin, body });
      if (req.url === "/api/session") {
        if (sessionMode === "error") return res.writeHead(500).end("broken");
        if (sessionMode === "malformed") return res.writeHead(200, { "content-type": "application/json" }).end('{"user":');
        if (sessionMode === "missing-user") return res.writeHead(200, { "content-type": "application/json" }).end('{"user":null}');
        if (sessionMode === "oversized") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user: { username: "reviewer", padding: "x".repeat(17_000) } }));
        if (req.headers.cookie === "session=valid") return res.writeHead(200, { "content-type": "application/json" }).end('{"user":{"username":"reviewer"}}');
        return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"LOGIN_REQUIRED"}');
      }
      res.writeHead(207, {
        "content-type": "application/octet-stream",
        location: "/preserved-location",
        "set-cookie": ["meatbox_session=preserved; HttpOnly; SameSite=Strict"],
      });
      res.end(body.length ? body : Buffer.from([0, 1, 2, 255]));
    });
  });
  return { server, seen, setSessionMode(value) { sessionMode = value; } };
}

test("gateway configuration accepts only exact loopback HTTP origins", async () => {
  const distDirectory = await fixtureDist();
  const valid = { apiOrigin: "http://127.0.0.1:3001", publicOrigin: "http://localhost:4173", distDirectory };
  assert.doesNotThrow(() => createLegacyGateway(valid));
  for (const apiOrigin of ["https://127.0.0.1:3001", "http://example.com:3001", "http://127.0.0.1:3001/", "http://127.0.0.1:3001/path"]) {
    assert.throws(() => createLegacyGateway({ ...valid, apiOrigin }), /exact loopback HTTP origin/);
  }
});

test("HTTPS public origin remains distinct from private loopback listener and API", async t => {
  const distDirectory = await fixtureDist();
  const fixture = createFixtureApi();
  const apiOrigin = await listen(fixture.server);
  const publicOrigin = "https://meatbox.test.invalid";
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory });
  const listenerOrigin = await listen(gateway.server);
  t.after(() => gateway.close());
  t.after(() => new Promise(resolve => fixture.server.close(resolve)));
  const anonymous = await requestRaw(listenerOrigin, "/combined/");
  assert.equal(anonymous.status, 302);
  const protectedView = await requestRaw(listenerOrigin, "/combined/", { headers: {cookie:"session=valid"} });
  assert.equal(protectedView.status, 200);
  assert.match(protectedView.headers["content-security-policy"], /wss:\/\/meatbox\.test\.invalid/);
  const post = await requestRaw(listenerOrigin, "/login", {method:"POST", headers:{origin:publicOrigin,"content-type":"application/x-www-form-urlencoded"},body:"username=reviewer"});
  assert.equal(post.status, 207);
  assert.equal(fixture.seen.at(-1).origin, publicOrigin);
  assert.equal(post.headers["set-cookie"][0], "meatbox_session=preserved; HttpOnly; SameSite=Strict");
  for (const invalid of ["http://meatbox.test.invalid", "https://meatbox.test.invalid/", "https://user@meatbox.test.invalid", "https://meatbox.test.invalid/path", "https://meatbox.test.invalid:0"]) {
    assert.throws(()=>createLegacyGateway({apiOrigin,publicOrigin:invalid,distDirectory}), /exact HTTPS or loopback HTTP origin/);
  }
});

test("interrupted upstream bodies terminate API responses and fail closed for session checks", async t => {
  const distDirectory = await fixtureDist();
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    res.write('{"user":');
    setTimeout(() => res.destroy(), 20);
  });
  const apiOrigin = await listen(upstream);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory, timeoutMs: 300 });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => { await gateway.close(); await new Promise(resolve => upstream.close(resolve)); });
  assert.equal((await requestRaw(publicOrigin, "/combined/")).status, 503);
  await assert.rejects(async () => {
    const response = await fetch(`${publicOrigin}/api/probe`, { signal: AbortSignal.timeout(1000) });
    await response.text();
  }, error => error.name !== "TimeoutError");
});

test("static UI is session protected while exact portal files remain public", async t => {
  const distDirectory = await fixtureDist();
  const api = createFixtureApi();
  const apiOrigin = await listen(api.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory, timeoutMs: 500 });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => { await gateway.close(); await new Promise(resolve => api.server.close(resolve)); });

  for (const url of ["/login", "/dev/register", "/portal.css", "/theme.css", "/components.css", "/portal-logo.svg", "/portal-font.ttf", "/portal-validation.js", "/portal-auth.js"]) {
    assert.equal((await requestRaw(publicOrigin, url)).status, 200, url);
  }
  const denied = await requestRaw(publicOrigin, "/combined/app.mjs?id=S5");
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.location, "/login?next=%2Fcombined%2Fapp.mjs%3Fid%3DS5");
  const allowed = await requestRaw(publicOrigin, "/combined/app.mjs", { headers: { cookie: "session=valid", "accept-encoding": "gzip" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(allowed.headers["content-encoding"], "gzip");
  assert.equal(Number(allowed.headers["content-length"]), allowed.body.length);
  assert.match(gunzipSync(allowed.body).toString(), /export const app/);
  assert.equal(allowed.headers["cache-control"], "no-store");
  assert.equal(allowed.headers["x-content-type-options"], "nosniff");
  assert.equal(allowed.headers["x-frame-options"], "DENY");
  assert.match(allowed.headers["content-security-policy"], /default-src 'self'/);
  assert.equal((await requestRaw(publicOrigin, "/portal.css/extra")).status, 302);
  assert.equal((await requestRaw(publicOrigin, "/theme.css/extra")).status, 302);
  assert.equal((await requestRaw(publicOrigin, "/components.css/extra")).status, 302);
  assert.equal((await requestRaw(publicOrigin, "/theme.js")).status, 302);

  assert.equal((await requestRaw(publicOrigin, "/login?next=https://attacker.invalid", { headers: { cookie: "session=valid" } })).headers.location, "/");
  assert.equal((await requestRaw(publicOrigin, "/login?next=%2Fscenario%2Fcustomer", { headers: { cookie: "session=valid" } })).headers.location, "/");
  assert.equal((await requestRaw(publicOrigin, "/login?next=%2Fcombined%2F%3Fdate%3D2026-10-05", { headers: { cookie: "session=valid" } })).headers.location, "/combined/?date=2026-10-05");
  assert.equal((await requestRaw(publicOrigin, "/login?next=%2Fui-layout%2F", { headers: { cookie: "session=valid" } })).headers.location, "/ui-layout/");
  for (const mode of ["malformed", "missing-user", "oversized", "error"]) {
    api.setSessionMode(mode);
    assert.equal((await requestRaw(publicOrigin, "/combined/", { headers: { cookie: "session=valid" } })).status, 503, mode);
  }
});

test("API and authentication proxy preserve status, body, cookie, origin and redirects", async t => {
  const distDirectory = await fixtureDist();
  const api = createFixtureApi();
  const apiOrigin = await listen(api.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => { await gateway.close(); await new Promise(resolve => api.server.close(resolve)); });
  const body = Buffer.from("username=reviewer&password=secret-value");
  const response = await requestRaw(publicOrigin, "/login?next=%2Fcombined%2F", {
    method: "POST",
    headers: { cookie: "incoming=cookie", origin: publicOrigin, "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) },
    body,
  });
  assert.equal(response.status, 207);
  assert.equal(response.headers.location, "/preserved-location");
  assert.match(response.headers["set-cookie"][0], /meatbox_session=preserved/);
  assert.deepEqual(response.body, body);
  const proxied = api.seen.find(item => item.url.startsWith("/login?"));
  assert.equal(proxied.cookie, "incoming=cookie");
  assert.equal(proxied.origin, publicOrigin);
  assert.deepEqual(proxied.body, body);
  const binary = await requestRaw(publicOrigin, "/api/probe", { headers: { cookie: "incoming=cookie", origin: publicOrigin } });
  assert.equal(binary.status, 207);
  assert.deepEqual(binary.body, Buffer.from([0, 1, 2, 255]));
  const seenBefore = api.seen.length;
  assert.equal((await requestRaw(publicOrigin, "http://attacker.invalid/api/session")).status, 400);
  assert.equal((await requestRaw(publicOrigin, "//attacker.invalid/api/session")).status, 400);
  assert.equal(api.seen.length, seenBefore);
});

test("current aliases remain while retired demo URLs return the exact tombstone without API access", async t => {
  const distDirectory = await fixtureDist();
  const api = createFixtureApi();
  const apiOrigin = await listen(api.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => { await gateway.close(); await new Promise(resolve => api.server.close(resolve)); });
  const headers = { cookie: "session=valid" };
  const aliases = new Map([
    ["/", "/combined/"], ["/combined?date=1", "/combined/?date=1"],
    ["/ui-layout?sample=button", "/ui-layout/?sample=button"],
    ["/control?ignored=1", "/combined/#/control"],
  ]);
  for (const [url, location] of aliases) {
    const response = await requestRaw(publicOrigin, url, { headers });
    assert.equal(response.status, 308, url);
    assert.equal(response.headers.location, location, url);
  }
  const seenBefore = api.seen.length;
  for (const url of [
    "/scenario", "/scenario/", "/scenario/api/route-data", "/scenario/customer.html?id=S5",
    "/customer?id=S5", "/driver", "/present", "/combined/driver.html",
    "/combined/mobile-customer.html?delivery=S5", "/ws/simulation",
  ]) {
    const response = await requestRaw(publicOrigin, url);
    assert.equal(response.status, 410, url);
    assert.equal(response.body.toString(), "Old demo removed\n", url);
    assert.equal(response.headers["cache-control"], "no-store", url);
  }
  assert.equal(api.seen.length, seenBefore);
  assert.equal((await requestRaw(publicOrigin, "/scenario-old")).status, 302);
});

test("static lookup rejects traversal, hidden build sources and symlinks", async t => {
  const distDirectory = await fixtureDist();
  const outside = path.join(path.dirname(distDirectory), `${path.basename(distDirectory)}-outside.txt`);
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(distDirectory, "combined/leak.txt"));
  await fs.mkdir(path.join(distDirectory, "src"));
  await fs.writeFile(path.join(distDirectory, "src/private.js"), "secret");
  await fs.writeFile(path.join(distDirectory, "combined/app.js.map"), "source map");
  await fs.writeFile(path.join(distDirectory, "combined/model.test.mjs"), "test source");
  const api = createFixtureApi();
  const apiOrigin = await listen(api.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.close();
    await new Promise(resolve => api.server.close(resolve));
    await fs.rm(outside, { force: true });
  });
  const headers = { cookie: "session=valid" };
  for (const url of ["/combined/%2e%2e/portal.css", "/.env", "/src/private.js", "/combined/app.js.map", "/combined/model.test.mjs", "/combined/leak.txt"]) {
    assert.equal((await requestRaw(publicOrigin, url, { headers })).status, 404, url);
  }
  const head = await requestRaw(publicOrigin, "/combined/style.css", { method: "HEAD", headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(head.body.length, 0);
  assert.ok(Number(head.headers["content-length"]) > 0);
});

function waitForWebSocket(ws, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${event} timeout`)), 2_000);
    ws.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    ws.once("error", error => { if (event !== "error") { clearTimeout(timer); reject(error); } });
  });
}

test("simulation WebSocket is retired without forwarding while unknown upgrades remain missing", async t => {
  const distDirectory = await fixtureDist();
  const api = createFixtureApi();
  const apiOrigin = await listen(api.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => { await gateway.close(); await new Promise(resolve => api.server.close(resolve)); });

  const wrongPath = new WebSocket(publicOrigin.replace("http", "ws") + "/ws/other");
  const [, wrongPathResponse] = await waitForWebSocket(wrongPath, "unexpected-response");
  assert.equal(wrongPathResponse.statusCode, 404);
  wrongPath.terminate();

  const retired = new WebSocket(publicOrigin.replace("http", "ws") + "/ws/simulation?source=old");
  const [, retiredResponse] = await waitForWebSocket(retired, "unexpected-response");
  assert.equal(retiredResponse.statusCode, 410);
  retiredResponse.resume();
  retired.terminate();
  assert.equal(api.seen.length, 0);
});

test("protected requests fail closed when the legacy API is unavailable", async t => {
  const distDirectory = await fixtureDist();
  const apiOrigin = await unusedOrigin();
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory, timeoutMs: 100 });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(() => gateway.close());
  assert.equal((await requestRaw(publicOrigin, "/dev/register")).status, 200);
  assert.equal((await requestRaw(publicOrigin, "/portal.css")).status, 200);
  assert.equal((await requestRaw(publicOrigin, "/login")).status, 503);
  assert.equal((await requestRaw(publicOrigin, "/combined/", { headers: { cookie: "session=valid" } })).status, 503);
  assert.equal((await requestRaw(publicOrigin, "/api/session", { headers: { cookie: "session=valid" } })).status, 503);
});
