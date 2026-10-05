import { defineConfig } from "vite";
import { resolve } from "node:path";
import { createKotlinApiMiddleware, exactLoopbackOrigin } from "./scripts/api-routing.mjs";

const root = import.meta.dirname;
const portalAuth = resolve(root, "src/auth.ts");
const apiTarget = exactLoopbackOrigin(process.env.MEATBOX_LEGACY_API_ORIGIN || "http://127.0.0.1:3001", "MEATBOX_LEGACY_API_ORIGIN");
const kotlinApiTarget = process.env.MEATBOX_KOTLIN_API_ORIGIN === undefined
  ? null
  : exactLoopbackOrigin(process.env.MEATBOX_KOTLIN_API_ORIGIN, "MEATBOX_KOTLIN_API_ORIGIN");
const proxyTimeoutMs = 5_000;
const authOwner = process.env.MEATBOX_AUTH_OWNER || "node";
const dispatchOwner = process.env.MEATBOX_DISPATCH_OWNER || "node";
if (![authOwner, dispatchOwner].every(owner => ["node", "kotlin"].includes(owner)) || ((authOwner === "kotlin" || dispatchOwner === "kotlin") && !kotlinApiTarget)) throw new Error("Invalid native API owner");
const resourceOwner = process.env.MEATBOX_RESOURCES_OWNER || "node";
if (!["node", "kotlin"].includes(resourceOwner) || (resourceOwner === "kotlin" && !kotlinApiTarget)) throw new Error("Kotlin resources require a Kotlin origin and explicit ownership");

export default defineConfig({
  appType: "mpa",
  plugins: [{
    name: "meatbox-portal-auth",
    resolveId(source) {
      if (source === "/portal-auth.js") return portalAuth;
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url?.split("?")[0] === "/portal-auth.js") request.url = "/src/auth.ts";
        next();
      });
    },
  }, {
    name: "meatbox-kotlin-api-route",
    configureServer(server) {
      if (!kotlinApiTarget) return;
      server.middlewares.use(createKotlinApiMiddleware(kotlinApiTarget, proxyTimeoutMs, resourceOwner === "kotlin", authOwner === "kotlin", dispatchOwner === "kotlin"));
    },
  }],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget.origin,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: ".runtime/dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: false,
    rolldownOptions: {
      input: {
        combined: resolve(root, "combined/index.html"),
        layout: resolve(root, "ui-layout/index.html"),
        login: resolve(root, "login/index.html"),
        register: resolve(root, "dev/register/index.html"),
        "portal-auth": portalAuth,
      },
      output: {
        entryFileNames: chunk => chunk.name === "portal-auth" ? "portal-auth.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
