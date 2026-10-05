import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createLegacyGateway } from "./legacy-gateway.mjs";
import { exactPublicOrigin } from "./api-routing.mjs";

const host = "127.0.0.1";
const port = Number(process.env.MEATBOX_LEGACY_GATEWAY_PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MEATBOX_LEGACY_GATEWAY_PORT must be a valid port");
const publicOrigin = process.env.MEATBOX_LEGACY_PUBLIC_ORIGIN || `http://${host}:${port}`;
const apiOrigin = process.env.MEATBOX_LEGACY_API_ORIGIN || "http://127.0.0.1:3001";
const kotlinApiOrigin = process.env.MEATBOX_KOTLIN_API_ORIGIN;
const resourceOwner = process.env.MEATBOX_RESOURCES_OWNER || "node";
if (!["node", "kotlin"].includes(resourceOwner)) throw new Error("MEATBOX_RESOURCES_OWNER must be node or kotlin");
const publicUrl = exactPublicOrigin(publicOrigin);
const publicPort = Number(publicUrl.port || (publicUrl.protocol === "https:" ? 443 : 80));
if (publicUrl.protocol === "http:" && publicPort !== port) throw new Error("Loopback HTTP public origin must use MEATBOX_LEGACY_GATEWAY_PORT");
const directory = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.resolve(directory, "../.runtime/dist");
const authOwner = process.env.MEATBOX_AUTH_OWNER || "node";
const dispatchOwner = process.env.MEATBOX_DISPATCH_OWNER || "node";
if (![authOwner, dispatchOwner].every(owner => ["node", "kotlin"].includes(owner))) throw new Error("Invalid native API owner");
const gateway = createLegacyGateway({ apiOrigin, kotlinApiOrigin, kotlinResources:resourceOwner === "kotlin", kotlinAuth:authOwner === "kotlin", kotlinDispatch:dispatchOwner === "kotlin", publicOrigin, distDirectory });

gateway.server.listen(port, host, () => {
  console.log(`Meatbox legacy transition gateway ready at ${publicOrigin}`);
  console.log(`Start the legacy Node API with PUBLIC_ORIGIN=${publicOrigin}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await gateway.close();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop().then(() => process.exit(0), () => process.exit(1)));
}
