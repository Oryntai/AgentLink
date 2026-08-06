import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNamedArgs } from "./setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseNamedArgs(process.argv.slice(2));
const filePath = path.resolve(
  process.env.AGENT_LINK_NOTIFICATION_CONFIG
    || path.join(rootDir, ".agent-link", "notifications.json"),
);
let settings = {};
try {
  settings = JSON.parse(await readFile(filePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (args.local) {
  if (!["true", "false"].includes(args.local)) throw new Error("--local must be true or false");
  settings.local = args.local === "true";
}
if (args["disable-phone"] === "true") {
  delete settings.phoneWebhookUrl;
  delete settings.phoneProvider;
}
if (args["phone-webhook"]) {
  const url = new URL(args["phone-webhook"]);
  if (url.protocol !== "https:") throw new Error("--phone-webhook must use HTTPS");
  const provider = args.provider || "webhook";
  if (!['webhook', 'ntfy'].includes(provider)) throw new Error("--provider must be webhook or ntfy");
  settings.phoneWebhookUrl = url.toString();
  settings.phoneProvider = provider;
}

await mkdir(path.dirname(filePath), { recursive: true });
const temporaryPath = `${filePath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryPath, filePath);
console.log(`Notification settings updated: ${filePath}`);
console.log(`Local notifications: ${settings.local === false ? "off" : "on"}`);
console.log(`Phone notifications: ${settings.phoneWebhookUrl ? `${settings.phoneProvider || "webhook"} configured` : "off"}`);
