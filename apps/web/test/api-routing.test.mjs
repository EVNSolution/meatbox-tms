import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { createKotlinApiMiddleware, exactLoopbackOrigin, usesKotlinApi, usesKotlinResources, usesKotlinAuth, usesKotlinDispatch } from "../scripts/api-routing.mjs";
import { createLegacyGateway } from "../scripts/legacy-gateway.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixtureDist() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meatbox-api-routing-"));
  temporaryDirectories.push(directory);
  await fs.mkdir(path.join(directory, "combined"), { recursive: true });
  await fs.writeFile(path.join(directory, "combined/index.html"), "<h1>combined</h1>");
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

function recordingApi(label, { gzip = false, status } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, body: Buffer.concat(chunks) });
      const payload = Buffer.from(JSON.stringify({ upstream: label, url: req.url }));
      const body = gzip ? gzipSync(payload) : payload;
      const headers = {
        "content-type": "application/json",
        "content-length": String(body.length),
        "set-cookie": `${label}=preserved; HttpOnly`,
      };
      if (gzip) headers["content-encoding"] = "gzip";
      res.writeHead(status ?? (label === "kotlin" ? 206 : 207), headers);
      res.end(req.method === "HEAD" ? undefined : body);
    });
  });
  return { server, seen };
}

test("Kotlin source API selection is limited to four exact read contracts", () => {
  for (const [method, url] of [
    ["GET", "/api/dispatch-data/manifest"],
    ["GET", "/api/dispatch-data/destinations?date=2026-10-05&q=%ED%95%A9%EC%84%B1&page=1"],
    ["HEAD", "/api/dispatch-data/regions?revision=raw%2Bvalue"],
    ["GET", "/api/dispatch-data/days/2026-02-30"],
    ["GET", "/api/dispatch-data/days/not-a-date?raw=%2F%2B"],
  ]) assert.equal(usesKotlinApi(method, url), true, `${method} ${url}`);

  for (const [method, url] of [
    ["POST", "/api/dispatch-data/manifest"],
    ["PUT", "/api/dispatch-data/regions"],
    ["GET", "/api/dispatch-data/days/2026-10-05/state"],
    ["GET", "/api/dispatch-data/days/2026-10-05/commands"],
    ["GET", "/api/dispatch-data/days/2026-10-05/commandsX"],
    ["GET", "/api/dispatch-data/days/"],
    ["POST", "/api/dispatch-data/destinations"],
    ["GET", "/api/session"],
    ["GET", "/scenario/api/route-data"],
    ["GET", "http://attacker.invalid/api/dispatch-data/manifest"],
  ]) assert.equal(usesKotlinApi(method, url), false, `${method} ${url}`);
});

test("API origins accept only exact loopback HTTP origins", () => {
  for (const origin of ["http://127.0.0.1:3001", "http://localhost:8081", "http://[::1]:8081"]) {
    assert.equal(exactLoopbackOrigin(origin, "origin").origin, origin);
  }
  for (const origin of ["", "https://127.0.0.1:8081", "http://example.com:8081", "http://127.0.0.1:8081/", "http://127.0.0.1:8081/path", "http://user@127.0.0.1:8081"]) {
    assert.throws(() => exactLoopbackOrigin(origin, "origin"), /exact loopback HTTP origin/);
  }
});

test("gateway preserves selected Kotlin responses and leaves writers on Node", async t => {
  const distDirectory = await fixtureDist();
  const legacy = recordingApi("legacy");
  const kotlin = recordingApi("kotlin", { gzip: true });
  const apiOrigin = await listen(legacy.server);
  const kotlinApiOrigin = await listen(kotlin.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, kotlinApiOrigin, publicOrigin, distDirectory, timeoutMs: 500 });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.close();
    await Promise.all([legacy.server, kotlin.server].map(server => new Promise(resolve => server.close(resolve))));
  });

  const selected = await requestRaw(publicOrigin, "/api/dispatch-data/manifest?revision=raw%2Bvalue", {
    headers: { cookie: "session=preserved", "accept-encoding": "gzip" },
  });
  assert.equal(selected.status, 206);
  assert.equal(selected.headers["content-encoding"], "gzip");
  assert.equal(selected.headers["cache-control"], "no-store");
  assert.equal(selected.headers["x-content-type-options"], "nosniff");
  assert.equal(selected.headers["x-meatbox-source-reader"], "kotlin");
  assert.match(selected.headers["set-cookie"][0], /kotlin=preserved/);
  assert.equal(selected.headers["transfer-encoding"], undefined);
  assert.equal(kotlin.seen[0].url, "/api/dispatch-data/manifest?revision=raw%2Bvalue");
  assert.equal(kotlin.seen[0].cookie, "session=preserved");
  assert.deepEqual(JSON.parse(gunzipSync(selected.body)), { upstream: "kotlin", url: "/api/dispatch-data/manifest?revision=raw%2Bvalue" });

  const head = await requestRaw(publicOrigin, "/api/dispatch-data/regions?raw=%2F%2B", { method: "HEAD", headers: { cookie: "head=cookie" } });
  assert.equal(head.status, 206);
  assert.equal(head.body.length, 0);
  assert.ok(Number(head.headers["content-length"]) > 0);
  assert.deepEqual(kotlin.seen.at(-1), { method: "HEAD", url: "/api/dispatch-data/regions?raw=%2F%2B", cookie: "head=cookie", body: Buffer.alloc(0) });

  const invalidDate = await requestRaw(publicOrigin, "/api/dispatch-data/days/2026-02-30");
  assert.equal(invalidDate.status, 206);
  assert.equal(kotlin.seen.at(-1).url, "/api/dispatch-data/days/2026-02-30");

  for (const [method, url] of [
    ["POST", "/api/dispatch-data/manifest"],
    ["POST", "/api/dispatch-data/days/2026-10-05/commands"],
    ["GET", "/api/dispatch-data/days/2026-10-05/state"],
    ["GET", "/api/dispatch-data/days/2026-10-05/commandsX"],
    ["POST", "/api/dispatch-data/destinations"],
    ["GET", "/api/session"],
  ]) {
    const body = method === "POST" ? Buffer.from('{"revision":1}') : undefined;
    const response = await requestRaw(publicOrigin, url, {
      method,
      headers: body ? { "content-type": "application/json", "content-length": String(body.length) } : undefined,
      body,
    });
    assert.equal(response.status, 207, `${method} ${url}`);
    assert.equal(legacy.seen.at(-1).url, url);
    if (body) assert.deepEqual(legacy.seen.at(-1).body, body);
  }
  const legacyRequests = legacy.seen.length;
  const kotlinRequests = kotlin.seen.length;
  const retired = await requestRaw(publicOrigin, "/scenario/api/route-data");
  assert.equal(retired.status, 410);
  assert.equal(retired.body.toString(), "Old demo removed\n");
  assert.equal(legacy.seen.length, legacyRequests);
  assert.equal(kotlin.seen.length, kotlinRequests);
});

test("retired demo HTTP routes never reach an API in any ownership mode", async t => {
  const distDirectory = await fixtureDist();
  const legacy = recordingApi("legacy");
  const kotlin = recordingApi("kotlin");
  const apiOrigin = await listen(legacy.server);
  const kotlinApiOrigin = await listen(kotlin.server);
  t.after(async () => {
    await Promise.all([legacy.server, kotlin.server].map(server => new Promise(resolve => server.close(resolve))));
  });
  const ownershipModes = [
    {},
    { kotlinApiOrigin },
    { kotlinApiOrigin, kotlinResources: true },
    { kotlinApiOrigin, kotlinAuth: true },
    { kotlinApiOrigin, kotlinDispatch: true },
    { kotlinApiOrigin, kotlinResources: true, kotlinAuth: true, kotlinDispatch: true },
  ];
  for (const ownership of ownershipModes) {
    const publicOrigin = await unusedOrigin();
    const gateway = createLegacyGateway({ apiOrigin, publicOrigin, distDirectory, ...ownership });
    await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
    const retired = await requestRaw(publicOrigin, "/scenario/api/route-data?source=old");
    assert.equal(retired.status, 410);
    assert.equal(retired.body.toString(), "Old demo removed\n");
    await gateway.close();
  }
  assert.equal(legacy.seen.length, 0);
  assert.equal(kotlin.seen.length, 0);
});

test("resource ownership selects the complete resource boundary and never falls back", async t => {
  for (const [method,url] of [["GET","/api/resources"],["HEAD","/api/resources/"],["POST","/api/resources/region-codes"],["PATCH","/api/resources/vehicles/V1"],["PATCH","/api/resources/vehicles"]]) assert.equal(usesKotlinResources(method,url),true);
  for (const [method,url] of [["GET","/api/resourcesX"],["POST","/api/session"],["GET","//attacker.invalid/api/resources"]]) assert.equal(usesKotlinResources(method,url),false);
  const legacy = recordingApi("legacy");
  const apiOrigin = await listen(legacy.server);
  const distDirectory = await fixtureDist();
  const kotlinApiOrigin = await unusedOrigin();
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({apiOrigin,kotlinApiOrigin,kotlinResources:true,publicOrigin,distDirectory,timeoutMs:100});
  await new Promise(resolve=>gateway.server.listen(new URL(publicOrigin).port,"127.0.0.1",resolve));
  t.after(async()=>{await gateway.close();await new Promise(resolve=>legacy.server.close(resolve));});
  const response = await requestRaw(publicOrigin,"/api/resources/region-codes",{method:"POST",body:'{"revision":0,"code":"TEST"}'});
  assert.equal(response.status,503);
  assert.equal(response.headers["x-meatbox-resource-owner"],"kotlin");
  assert.equal(response.headers["x-meatbox-source-reader"],undefined);
  assert.equal(legacy.seen.length,0);
  assert.throws(()=>createLegacyGateway({apiOrigin,kotlinResources:true,publicOrigin,distDirectory}),/require a Kotlin origin/);
});

test("Vite authoring middleware applies the same exact Kotlin selection", async t => {
  const kotlin = recordingApi("kotlin");
  const kotlinApiOrigin = await listen(kotlin.server);
  const kotlinApiTarget = exactLoopbackOrigin(kotlinApiOrigin, "kotlinApiOrigin");
  const middleware = createKotlinApiMiddleware(kotlinApiTarget, 500);
  let fallbacks = 0;
  const authoring = http.createServer((req, res) => middleware(req, res, () => {
    fallbacks += 1;
    res.writeHead(299, { "content-length": "0" }).end();
  }));
  const authoringOrigin = await listen(authoring);
  t.after(async () => {
    await Promise.all([authoring, kotlin.server].map(server => new Promise(resolve => server.close(resolve))));
  });

  const selected = await requestRaw(authoringOrigin, "/api/dispatch-data/days/bad-date?raw=%2F%2B", { headers: { cookie: "session=vite" } });
  assert.equal(selected.status, 206);
  assert.equal(kotlin.seen.at(-1).url, "/api/dispatch-data/days/bad-date?raw=%2F%2B");
  assert.equal(kotlin.seen.at(-1).cookie, "session=vite");

  assert.equal((await requestRaw(authoringOrigin, "/api/dispatch-data/days/bad-date/state")).status, 299);
  assert.equal((await requestRaw(authoringOrigin, "/api/dispatch-data/manifest", { method: "POST" })).status, 299);
  assert.equal(fallbacks, 2);
  assert.equal(kotlin.seen.length, 1);
});

test("selected Kotlin connection failures return JSON 503 without Node fallback", async t => {
  const distDirectory = await fixtureDist();
  const legacy = recordingApi("legacy");
  const apiOrigin = await listen(legacy.server);
  const kotlinApiOrigin = await unusedOrigin();
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, kotlinApiOrigin, publicOrigin, distDirectory, timeoutMs: 100 });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.close();
    await new Promise(resolve => legacy.server.close(resolve));
  });

  const failed = await requestRaw(publicOrigin, "/api/dispatch-data/regions?raw=query", { headers: { cookie: "session=valid" } });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers["x-content-type-options"], "nosniff");
  assert.equal(failed.headers["x-meatbox-source-reader"], "kotlin");
  assert.deepEqual(JSON.parse(failed.body), { error: "KOTLIN_API_UNAVAILABLE" });
  assert.equal(legacy.seen.length, 0);

  const writer = await requestRaw(publicOrigin, "/api/dispatch-data/regions", { method: "POST" });
  assert.equal(writer.status, 207);
  assert.equal(legacy.seen.length, 1);
});

test("selected Kotlin timeouts return JSON 503 without Node fallback", async t => {
  const distDirectory = await fixtureDist();
  const legacy = recordingApi("legacy");
  const hanging = http.createServer(() => {});
  const apiOrigin = await listen(legacy.server);
  const kotlinApiOrigin = await listen(hanging);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, kotlinApiOrigin, publicOrigin, distDirectory, timeoutMs: 30 });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.close();
    await Promise.all([legacy.server, hanging].map(server => new Promise(resolve => server.close(resolve))));
  });

  const failed = await requestRaw(publicOrigin, "/api/dispatch-data/manifest");
  assert.equal(failed.status, 503);
  assert.deepEqual(JSON.parse(failed.body), { error: "KOTLIN_API_UNAVAILABLE" });
  assert.equal(legacy.seen.length, 0);
});

test("selected Kotlin error statuses retain the reader marker and never fall back", async t => {
  const distDirectory = await fixtureDist();
  const legacy = recordingApi("legacy");
  const kotlin = recordingApi("kotlin", { status: 404 });
  const apiOrigin = await listen(legacy.server);
  const kotlinApiOrigin = await listen(kotlin.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, kotlinApiOrigin, publicOrigin, distDirectory });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.close();
    await Promise.all([legacy.server, kotlin.server].map(server => new Promise(resolve => server.close(resolve))));
  });

  const response = await requestRaw(publicOrigin, "/api/dispatch-data/days/missing");
  assert.equal(response.status, 404);
  assert.equal(response.headers["x-meatbox-source-reader"], "kotlin");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(kotlin.seen.length, 1);
  assert.equal(legacy.seen.length, 0);
});

function unexpectedWebSocketResponse(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket response timeout")), 2_000);
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      resolve(response);
    });
    ws.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("retired simulation WebSocket is never forwarded by Kotlin routing", async t => {
  const distDirectory = await fixtureDist();
  const legacy = recordingApi("legacy");
  const kotlin = recordingApi("kotlin");
  const apiOrigin = await listen(legacy.server);
  const kotlinApiOrigin = await listen(kotlin.server);
  const publicOrigin = await unusedOrigin();
  const gateway = createLegacyGateway({ apiOrigin, kotlinApiOrigin, publicOrigin, distDirectory });
  await new Promise(resolve => gateway.server.listen(new URL(publicOrigin).port, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.close();
    await Promise.all([legacy.server, kotlin.server].map(server => new Promise(resolve => server.close(resolve))));
  });

  const ws = new WebSocket(publicOrigin.replace("http", "ws") + "/ws/simulation");
  const response = await unexpectedWebSocketResponse(ws);
  assert.equal(response.statusCode, 410);
  response.resume();
  ws.terminate();
  assert.equal(legacy.seen.length, 0);
  assert.equal(kotlin.seen.length, 0);
});

test("gateway rejects an invalid optional Kotlin origin at startup", async () => {
  const distDirectory = await fixtureDist();
  const valid = { apiOrigin: "http://127.0.0.1:3001", publicOrigin: "http://127.0.0.1:4173", distDirectory };
  for (const kotlinApiOrigin of ["", "https://127.0.0.1:8081", "http://kotlin.invalid:8081", "http://127.0.0.1:8081/"]) {
    assert.throws(() => createLegacyGateway({ ...valid, kotlinApiOrigin }), /kotlinApiOrigin must be an exact loopback HTTP origin/);
  }
});


test("native auth and dispatch selection retains their exact owner boundaries", () => {
  assert.equal(usesKotlinAuth("POST", "/login?next=%2Fcombined%2F"), true);
  assert.equal(usesKotlinAuth("HEAD", "/api/session"), true);
  assert.equal(usesKotlinAuth("GET", "/login"), false);
  assert.equal(usesKotlinAuth("POST", "https://attacker.invalid/login"), false);
  assert.equal(usesKotlinAuth("POST", "/logout/extra"), false);
  assert.equal(usesKotlinDispatch("POST", "/api/dispatch-data/days/2026-10-05/commands"), true);
  assert.equal(usesKotlinDispatch("HEAD", "/api/dispatch-data/days/2026-10-05/state?revision=1"), true);
  assert.equal(usesKotlinDispatch("GET", "/api/dispatch-data/days/2026-10-05/commandsX"), false);
  assert.equal(usesKotlinDispatch("PUT", "/api/dispatch-data/days/2026-10-05/state"), false);
  assert.equal(usesKotlinDispatch("PUT", "/api/dispatch-data/days/2026-10-05/driver/push-token"), true);
  assert.equal(usesKotlinDispatch("DELETE", "/api/dispatch-data/days/2026-10-05/driver/push-token"), true);
  assert.equal(usesKotlinDispatch("POST", "/api/dispatch-data/days/2026-10-05/driver/messages"), true);
  assert.equal(usesKotlinDispatch("GET", "/api/dispatch-data/days/2026-10-05/driver/messages?vehicleId=TRUCK-1"), true);
  assert.equal(usesKotlinDispatch("DELETE", "/api/dispatch-data/days/2026-10-05/driver/messages"), false);
  assert.equal(usesKotlinDispatch("PUT", "/api/dispatch-data/days/2026-10-05/driver/push-token/other"), false);
});

test("native proxy overwrites client identity using the closest trusted proxy address", async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  const upstreamOrigin = await listen(upstream);
  const middleware = createKotlinApiMiddleware(new URL(upstreamOrigin), 1000, false, true, true);
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  const origin = await listen(server);
  t.after(async () => { await Promise.all([server, upstream].map(item => new Promise(resolve => item.close(resolve)))); });
  const login = await requestRaw(origin, "/login", { method: "POST", headers: {
    "x-meatbox-client-address": "forged", "x-forwarded-for": "203.0.113.5, 198.51.100.44",
  }, body: "username=example" });
  assert.equal(login.status, 200);
  assert.equal(login.headers["x-meatbox-auth-owner"], "kotlin");
  assert.equal(seen[0]["x-meatbox-client-address"], "198.51.100.44");
  const state = await requestRaw(origin, "/api/dispatch-data/days/2026-10-05/state", { headers: {
    "x-meatbox-client-address": "forged", "x-forwarded-for": "invalid",
  } });
  assert.equal(state.status, 200);
  assert.equal(state.headers["x-meatbox-dispatch-owner"], "kotlin");
  assert.equal(seen[1]["x-meatbox-client-address"], "127.0.0.1");
});
