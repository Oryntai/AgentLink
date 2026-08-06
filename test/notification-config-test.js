import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-notify-test-"));
const configPath = path.join(tempDir, "notifications.json");
const secretUrl = "https://notify.example.invalid/private-topic-token";

try {
  const env = { ...process.env, AGENT_LINK_NOTIFICATION_CONFIG: configPath };
  const output = execFileSync(process.execPath, [
    path.join(rootDir, "scripts", "configure-notifications.js"),
    "--local",
    "false",
    "--phone-webhook",
    secretUrl,
    "--provider",
    "ntfy",
  ], { cwd: rootDir, env, encoding: "utf8" });
  assert.doesNotMatch(output, /private-topic-token/);
  const configured = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(configured.local, false);
  assert.equal(configured.phoneProvider, "ntfy");
  assert.equal(configured.phoneWebhookUrl, secretUrl);

  execFileSync(process.execPath, [
    path.join(rootDir, "scripts", "configure-notifications.js"),
    "--disable-phone",
  ], { cwd: rootDir, env, encoding: "utf8" });
  const disabled = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(disabled.phoneWebhookUrl, undefined);
  console.log("NOTIFICATION PASS: private local settings and redacted phone adapter configuration verified");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
