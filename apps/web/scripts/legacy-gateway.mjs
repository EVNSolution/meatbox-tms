import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { gzip } from "node:zlib";
import { exactLoopbackOrigin, exactPublicOrigin, proxyKotlinApi, usesKotlinApi, usesKotlinResources, usesKotlinAuth, usesKotlinDispatch } from "./api-routing.mjs";

const PUBLIC_FILES = new Map([
  ["/login", "login/index.html"],
  ["/dev/register", "dev/register/index.html"],
  ["/portal.css", "portal.css"],
  ["/theme.css", "theme.css"],
  ["/components.css", "components.css"],
  ["/portal-logo.svg", "portal-logo.svg"],
  ["/portal-font.ttf", "portal-font.ttf"],
  ["/portal-validation.js", "portal-validation.js"],
  ["/portal-auth.js", "portal-auth.js"],
]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const MIME = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".ico", "image/x-icon"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"],
  [".wasm", "application/wasm"], [".txt", "text/plain; charset=utf-8"],
]);
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|wasm)|image\/svg\+xml)/;
const SESSION_RESPONSE_LIMIT = 16 * 1024;
const SESSION_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]){2,39}$/;
const RETIRED_DEMO_PATHS = new Set([
  "/customer",
  "/driver",
  "/present",
  "/combined/driver.html",
  "/combined/mobile-customer.html",
  "/ws/simulation",
]);
const RETIRED_DEMO_MESSAGE = "Old demo removed";

export function safeNext(value) {
  if (typeof value !== "string" || /[\\\r\n]/.test(value)) return "/";
  try {
    const target = new URL(value, "https://local.invalid");
    return target.origin === "https://local.invalid" && /^\/(?:$|(?:ui-layout|combined)(?:\/|$))/.test(target.pathname)
      ? `${target.pathname}${target.search}${target.hash}` : "/";
  } catch { return "/"; }
}

function securityHeaders(publicOrigin) {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src 'self'; img-src 'self' data: blob: https://tiles.openfreemap.org https://tile.openstreetmap.org https://cdnjs.cloudflare.com; connect-src 'self' https://tiles.openfreemap.org ${publicOrigin.replace(/^http/, "ws")}; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  };
}

function writePlain(res, status, message, headers) {
  const body = Buffer.from(`${message}\n`);
  res.writeHead(status, { ...headers, "content-type": "text/plain; charset=utf-8", "content-length": String(body.length) });
  res.end(body);
}

function redirect(res, status, location, headers) {
  res.writeHead(status, { ...headers, location, "content-length": "0" });
  res.end();
}

function rawPathIsUnsafe(rawUrl) {
  const rawPath = String(rawUrl || "/").split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return true; }
  if (decoded.includes("\0") || decoded.includes("\\")) return true;
  const segments = decoded.split("/").filter(Boolean);
  return segments.some(segment => segment === "." || segment === ".." || segment.startsWith("."));
}

function buildRelativeFile(pathname) {
  if (PUBLIC_FILES.has(pathname)) return PUBLIC_FILES.get(pathname);
  let relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  return relative;
}

function isRetiredDemoPath(pathname) {
  return pathname === "/scenario" || pathname.startsWith("/scenario/") || RETIRED_DEMO_PATHS.has(pathname);
}

function relativeFileIsUnsafe(relative) {
  const segments = relative.split("/").filter(Boolean);
  if (!segments.length || segments.some(segment => segment === "." || segment === ".." || segment.startsWith("."))) return true;
  if (segments.some(segment => /^(?:src|test|tests|scripts|node_modules)$/i.test(segment))) return true;
  const name = segments.at(-1);
  return /(?:^|[-_.])(?:secret|credential|private|access)(?:[-_.]|$)/i.test(name)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name)
    || /^(?:package(?:-lock)?\.json|tsconfig(?:\..+)?\.json|vite\.config\.|\.env)/i.test(name)
    || /\.(?:map|ts|tsx|pem|key|crt)$/i.test(name);
}

async function verifiedFile(root, relative) {
  if (relativeFileIsUnsafe(relative)) return null;
  const parts = relative.split("/");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return null;
  }
  const stat = await fs.stat(current);
  if (!stat.isFile()) return null;
  const canonical = await fs.realpath(current);
  if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) return null;
  return canonical;
}

function proxyHeaders(req, apiUrl) {
  const headers = { ...req.headers, host: apiUrl.host };
  delete headers.connection;
  delete headers.upgrade;
  delete headers["proxy-connection"];
  return headers;
}

function proxyHttp(req, res, apiUrl, timeoutMs, gatewayHeaders) {
  return new Promise(resolve => {
    let finished = false;
    function fail() {
      if (finished) return;
      finished = true;
      if (!res.destroyed) {
        if (!res.headersSent) writePlain(res, 503, "Legacy API unavailable", gatewayHeaders);
        else res.destroy();
      }
      resolve();
    }
    const upstream = http.request({
      protocol: apiUrl.protocol,
      hostname: apiUrl.hostname,
      port: apiUrl.port,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req, apiUrl),
    }, response => {
      const headers = { ...response.headers };
      for (const header of HOP_BY_HOP) delete headers[header];
      res.writeHead(response.statusCode || 502, response.statusMessage, headers);
      response.pipe(res);
      response.on("end", () => { finished = true; resolve(); });
      response.on("aborted", fail);
      response.on("error", fail);
      response.on("close", () => { if (!response.complete) fail(); });
    });
    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", fail);
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
}

function checkSession(req, apiUrl, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const headers = {};
    if (req.headers.cookie !== undefined) headers.cookie = req.headers.cookie;
    if (req.headers.origin !== undefined) headers.origin = req.headers.origin;
    const upstream = http.request({
      protocol: apiUrl.protocol,
      hostname: apiUrl.hostname,
      port: apiUrl.port,
      method: "GET",
      path: "/api/session",
      headers,
    }, response => {
      if (response.statusCode === 401) {
        response.resume();
        response.on("end", () => settle("unauthorized"));
        response.on("error", () => settle("unavailable"));
        return;
      }
      if (response.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] || "")) {
        response.resume();
        response.on("end", () => settle("unavailable"));
        response.on("error", () => settle("unavailable"));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > SESSION_RESPONSE_LIMIT) {
          response.destroy();
          settle("unavailable");
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const username = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            && parsed.user && typeof parsed.user === "object" && !Array.isArray(parsed.user)
            ? parsed.user.username : null;
          settle(typeof username === "string" && SESSION_USERNAME.test(username) ? "authorized" : "unavailable");
        } catch { settle("unavailable"); }
      });
      response.on("error", () => settle("unavailable"));
    });
    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => settle("unavailable"));
    upstream.end();
  });
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function gzipBuffer(body) {
  return new Promise((resolve, reject) => gzip(body, (error, compressed) => error ? reject(error) : resolve(compressed)));
}

export function createLegacyGateway({ apiOrigin, kotlinApiOrigin, kotlinResources = false, kotlinAuth = false, kotlinDispatch = false, publicOrigin, distDirectory, timeoutMs = 5_000 } = {}) {
  const apiUrl = exactLoopbackOrigin(apiOrigin, "apiOrigin");
  const kotlinApiUrl = kotlinApiOrigin === undefined ? null : exactLoopbackOrigin(kotlinApiOrigin, "kotlinApiOrigin");
  if (typeof kotlinResources !== "boolean" || (kotlinResources && !kotlinApiUrl)) throw new TypeError("Kotlin resources require a Kotlin origin and explicit ownership");
  if (![kotlinAuth, kotlinDispatch].every(value => typeof value === "boolean") || ((kotlinAuth || kotlinDispatch) && !kotlinApiUrl)) throw new TypeError("Native ownership requires an explicit Kotlin origin");
  const sessionUrl = kotlinAuth ? kotlinApiUrl : apiUrl;
  const native = kotlinAuth && kotlinDispatch;
  const publicUrl = exactPublicOrigin(publicOrigin);
  if (typeof distDirectory !== "string" || !path.isAbsolute(distDirectory)) throw new TypeError("distDirectory must be an absolute path");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  const headers = securityHeaders(publicUrl.origin);
  const sockets = new Set();
  let rootPromise;

  async function serveFile(req, res, pathname) {
    if (rawPathIsUnsafe(req.url)) return writePlain(res, 404, "Not Found", headers);
    const relative = buildRelativeFile(pathname);
    try {
      const root = await (rootPromise ||= fs.realpath(path.resolve(distDirectory)));
      const filename = await verifiedFile(root, relative);
      if (!filename) return writePlain(res, 404, "Not Found", headers);
      const type = MIME.get(path.extname(filename).toLowerCase()) || "application/octet-stream";
      let body = await fs.readFile(filename);
      const responseHeaders = { ...headers, "content-type": type };
      if (COMPRESSIBLE.test(type) && /(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(req.headers["accept-encoding"] || "")) {
        body = await gzipBuffer(body);
        responseHeaders["content-encoding"] = "gzip";
        responseHeaders.vary = "Accept-Encoding";
      }
      responseHeaders["content-length"] = String(body.length);
      res.writeHead(200, responseHeaders);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      writePlain(res, 503, "Frontend unavailable", headers);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method || "")) {
        return writePlain(res, 400, "Bad Request", headers);
      }
      if (rawPathIsUnsafe(req.url)) return writePlain(res, 404, "Not Found", headers);
      const target = new URL(req.url, publicUrl);
      if (target.origin !== publicUrl.origin) return writePlain(res, 400, "Bad Request", headers);
      const pathname = target.pathname;
      if (isRetiredDemoPath(pathname)) return writePlain(res, 410, RETIRED_DEMO_MESSAGE, headers);
      const isApi = pathname.startsWith("/api/");
      const isAuthPost = req.method === "POST" && ["/login", "/dev/register", "/logout"].includes(pathname);
      const resourceRequest = kotlinResources && usesKotlinResources(req.method, req.url);
      const boundary = kotlinAuth && usesKotlinAuth(req.method, req.url) ? "auth" : kotlinDispatch && usesKotlinDispatch(req.method, req.url) ? "dispatch" : resourceRequest;
      if (kotlinApiUrl && (boundary || usesKotlinApi(req.method, req.url) || (native && pathname.startsWith("/api/")))) {
        return void proxyKotlinApi(req, res, kotlinApiUrl, timeoutMs, boundary);
      }
      if (isApi || isAuthPost) return void proxyHttp(req, res, apiUrl, timeoutMs, headers);
      if (req.method !== "GET" && req.method !== "HEAD") return writePlain(res, 405, "Method Not Allowed", headers);

      if (pathname === "/login") {
        const session = await checkSession(req, sessionUrl, timeoutMs);
        if (session === "authorized") return redirect(res, 302, safeNext(target.searchParams.get("next")), headers);
        if (session === "unavailable") return writePlain(res, 503, "Legacy API unavailable", headers);
        return void await serveFile(req, res, pathname);
      }
      if (PUBLIC_FILES.has(pathname)) return void await serveFile(req, res, pathname);

      const session = await checkSession(req, sessionUrl, timeoutMs);
      if (session === "unavailable") return writePlain(res, 503, "Legacy API unavailable", headers);
      if (session === "unauthorized") {
        const next = safeNext(`${pathname}${target.search}`);
        return redirect(res, 302, `/login?next=${encodeURIComponent(next)}`, headers);
      }

      if (pathname === "/") return redirect(res, 308, "/combined/", headers);
      if (["/combined", "/ui-layout"].includes(pathname)) return redirect(res, 308, `${pathname}/${target.search}`, headers);
      if (pathname === "/control") return redirect(res, 308, "/combined/#/control", headers);
      return void await serveFile(req, res, pathname);
    } catch {
      if (!res.headersSent) writePlain(res, 503, "Gateway unavailable", headers);
      else res.destroy();
    }
  });

  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    let pathname;
    try {
      const target = new URL(req.url || "", publicUrl);
      if (target.origin === publicUrl.origin) pathname = target.pathname;
    } catch {}
    rejectUpgrade(socket, pathname === "/ws/simulation" ? 410 : 404,
      pathname === "/ws/simulation" ? RETIRED_DEMO_MESSAGE : "Not Found");
  });

  async function close() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  return { server, close };
}
