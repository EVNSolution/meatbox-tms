import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createLegacyGateway } from "../scripts/legacy-gateway.mjs";

const dist = path.resolve(import.meta.dirname, "../.runtime/dist");
const pages = [
  "combined/index.html", "ui-layout/index.html",
  "login/index.html", "dev/register/index.html",
];

test("every built page resolves its own scripts, styles and fixed public assets", async () => {
  for (const page of pages) {
    const html = await fs.readFile(path.join(dist, page), "utf8");
    assert.match(html, /<title>미트박스 TMS<\/title>/, page);
    for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"#]+)"/g)) {
      const url = new URL(match[1], `https://fixture.invalid/${page}`);
      if (url.origin !== "https://fixture.invalid") continue;
      assert.equal((await fs.stat(path.join(dist, url.pathname))).isFile(), true, `${page}: ${url.pathname}`);
    }
  }
  for (const asset of [
    "combined/assets/PretendardVariable.ttf", "combined/assets/OFL-1.1.txt",
    "combined/assets/vendor/maplibre/maplibre-gl-csp.js",
    "combined/assets/vendor/maplibre/maplibre-gl-csp-worker.js",
    "combined/assets/vendor/maplibre/LICENSE.txt", "combined/assets/maps/dsv-korea-v1.json",
    "combined/assets/maps/dsv-destination-marker.svg", "combined/assets/maps/dsv-vehicle-marker.svg",
  ]) assert.equal((await fs.stat(path.join(dist, asset))).isFile(), true, asset);
});

test("public authentication output is independent of protected UI chunks", async () => {
  for (const page of ["login/index.html", "dev/register/index.html"]) {
    const html = await fs.readFile(path.join(dist, page), "utf8");
    assert.match(html, /src="\/portal-auth\.js"/);
    assert.doesNotMatch(html, /(?:src|href)="\/assets\//);
    assert.doesNotMatch(html, /<script[^>]*>[^<\s]/);
  }
  const auth = await fs.readFile(path.join(dist, "portal-auth.js"), "utf8");
  assert.doesNotMatch(auth, /(?:import|export)\s.*["'].*\/assets\//);
  assert.doesNotMatch(auth, /dispatchPreview|fleetDeliveries|calculate_dispatch|maplibregl/);
});

test("built gateway retains response transformations, source isolation and authentication gates", async t => {
  const http = await import("node:http");
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/session" && req.headers.cookie === "meatbox_session=fixture") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: { username: "artifact-reviewer" } }));
    } else { res.writeHead(401); res.end(); }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const gateway = createLegacyGateway({
    apiOrigin: `http://127.0.0.1:${upstream.address().port}`,
    publicOrigin: "http://127.0.0.1:4173", distDirectory: dist,
  });
  await new Promise(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.close();
    await new Promise(resolve => upstream.close(resolve));
  });
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const get = (route, authenticated = true) => fetch(base + route, {
    redirect: "manual", headers: authenticated ? { cookie: "meatbox_session=fixture" } : {},
  });
  assert.equal((await get("/portal-auth.js", false)).status, 200);
  const theme = await get("/theme.css", false);
  assert.equal(theme.status, 200);
  const themeText = await theme.text();
  assert.match(themeText, /@font-face/);
  // Native legacy POST errors link portal.css alone, so it owns this dependency.
  const portal = await get("/portal.css", false);
  assert.equal(portal.status, 200);
  assert.match(await portal.text(), /@import\s+["']\/theme\.css["']/);
  const themeAssets = [...themeText.matchAll(/url\(["']?([^)'"\s]+)["']?\)/g)];
  assert.ok(themeAssets.length, "shared font must be available before login");
  for (const [, asset] of themeAssets) {
    assert.equal((await get(asset, false)).status, 200, `public theme asset: ${asset}`);
  }
  assert.equal((await get("/combined/assets/vendor/maplibre/maplibre-gl-csp-worker.js", false)).status, 302);
  for (const page of pages.slice(0, 2)) {
    const route = `/${page}`;
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(response.headers.get("content-security-policy"), /worker-src 'self'/);
    await response.text();
  }
  const layout = await (await get("/ui-layout/index.html")).text();
  const layoutCss = [...layout.matchAll(/href="([^"]+\.css)"/g)].map(match => match[1]);
  const cssText = (await Promise.all(layoutCss.map(async url => (await get(url)).text()))).join("\n");
  assert.match(layout, /id="design-guide"/);
  assert.doesNotMatch(layout, /scenario-tools|mobile-customer|driver\.html/);
  assert.match(cssText, /\.design-guide/);
  for (const route of ["/scenario/", "/scenario/customer", "/customer", "/driver", "/present", "/combined/driver.html", "/combined/mobile-customer.html"]) {
    assert.equal((await get(route)).status, 410, route);
  }
  for (const route of ["/server.js", "/lib/access.js", "/fork-inventory.json", "/src/auth.ts", "/combined/source-client.test.mjs"]) {
    assert.equal((await get(route)).status, 404, route);
  }
});
