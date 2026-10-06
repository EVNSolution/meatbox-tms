import http from "node:http";
import { isIP } from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const KOTLIN_READ_PATHS = new Set([
  "/api/dispatch-data/manifest",
  "/api/dispatch-data/regions",
  "/api/dispatch-data/destinations",
]);
const KOTLIN_DAY_PATH = /^\/api\/dispatch-data\/days\/[^/]+$/;

export function exactLoopbackOrigin(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${name} must be an exact loopback HTTP origin`); }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)
    || parsed.origin !== value || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError(`${name} must be an exact loopback HTTP origin`);
  }
  return parsed;
}

export function exactPublicOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("publicOrigin must be an exact HTTPS or loopback HTTP origin"); }
  if (parsed.origin !== value || parsed.username || parsed.password || parsed.port === "0"
    || parsed.pathname !== "/" || parsed.search || parsed.hash
    || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)))) {
    throw new TypeError("publicOrigin must be an exact HTTPS or loopback HTTP origin");
  }
  return parsed;
}

export function usesKotlinApi(method, rawUrl) {
  if (method !== "GET" && method !== "HEAD") return false;
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return false;
  let target;
  try { target = new URL(rawUrl, "http://127.0.0.1"); } catch { return false; }
  if (target.origin !== "http://127.0.0.1") return false;
  return KOTLIN_READ_PATHS.has(target.pathname) || KOTLIN_DAY_PATH.test(target.pathname);
}

export function usesKotlinResources(method, rawUrl) {
  if (!["GET", "HEAD", "POST", "PATCH"].includes(method)) return false;
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return false;
  let target;
  try { target = new URL(rawUrl, "http://127.0.0.1"); } catch { return false; }
  return target.origin === "http://127.0.0.1" && /^\/api\/resources(?:\/|$)/.test(target.pathname);
}

export function usesKotlinAuth(method, rawUrl) {
  const path = String(rawUrl || "").split("?", 1)[0];
  return (["GET", "HEAD"].includes(method) && path === "/api/session")
    || (method === "POST" && ["/login", "/dev/register", "/logout"].includes(path));
}

export function usesKotlinDispatch(method, rawUrl) {
  if (!["GET", "HEAD", "POST"].includes(method)) return false;
  return /^\/api\/dispatch-data\/days\/[^/?]+\/(?:state|commands)(?:\?|$)/.test(String(rawUrl || ""));
}

function ownerHeader(boundary) {
  return boundary === true ? "x-meatbox-resource-owner"
    : boundary === "auth" ? "x-meatbox-auth-owner"
      : boundary === "dispatch" ? "x-meatbox-dispatch-owner" : "x-meatbox-source-reader";
}

function proxyHeaders(req, targetUrl) {
  const headers = { ...req.headers, host: targetUrl.host };
  delete headers.connection;
  delete headers.upgrade;
  delete headers["proxy-connection"];
  delete headers["x-meatbox-client-address"];
  const peer = req.socket?.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").at(-1).trim();
  headers["x-meatbox-client-address"] = loopback && isIP(forwarded) ? forwarded : peer;
  return headers;
}

function unavailable(req, res, resourceRequest) {
  if (res.destroyed || res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from('{"error":"KOTLIN_API_UNAVAILABLE"}\n');
  res.writeHead(503, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
    [ownerHeader(resourceRequest)]: "kotlin",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

export function proxyKotlinApi(req, res, targetUrl, timeoutMs, resourceRequest = false) {
  return new Promise(resolve => {
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      unavailable(req, res, resourceRequest);
      resolve();
    };
    const upstream = http.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req, targetUrl),
    }, response => {
      const headers = { ...response.headers };
      for (const header of HOP_BY_HOP) delete headers[header];
      headers["cache-control"] = "no-store";
      headers["x-content-type-options"] = "nosniff";
      headers[ownerHeader(resourceRequest)] = "kotlin";
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

export function createKotlinApiMiddleware(targetUrl, timeoutMs = 5_000, resources = false, auth = false, dispatch = false) {
  return (req, res, next) => {
    const resourceRequest = resources && usesKotlinResources(req.method, req.url);
    const boundary = auth && usesKotlinAuth(req.method, req.url) ? "auth" : dispatch && usesKotlinDispatch(req.method, req.url) ? "dispatch" : resourceRequest;
    if (!boundary && !usesKotlinApi(req.method, req.url)) return next();
    void proxyKotlinApi(req, res, targetUrl, timeoutMs, boundary);
  };
}
