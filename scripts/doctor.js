import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(rootDir, ".agent-link");
const results = [];
const homeDir = process.env.USERPROFILE || os.homedir();
const appDataDir = process.env.APPDATA || (
  process.platform === "darwin"
    ? path.join(homeDir, "Library", "Application Support")
    : path.join(homeDir, ".config")
);

async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, label, detail });
  } catch (error) {
    results.push({ ok: false, label, detail: error.message });
  }
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

let localConfigs = [];
await check("Local participant configs", async () => {
  const available = (await readdir(configDir)).filter(
    (name) =>
      name.endsWith(".json") &&
      !name.endsWith(".state.json") &&
      !name.endsWith(".trust.json"),
  );
  const files = available.includes("active.json") ? ["active.json"] : available;
  if (!files.length) throw new Error("no participant configs found");
  localConfigs = await Promise.all(
    files.map(async (name) => {
      const configPath = path.join(configDir, name);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const { roomId } = parseRoomCode(config.roomCode);
      if (!config.identity?.publicKey || !config.identity?.privateKey) {
        throw new Error(`${name} has no Ed25519 identity`);
      }
      if (config.expiresAt && Date.parse(config.expiresAt) <= Date.now()) {
        throw new Error(`${name} expired at ${config.expiresAt}`);
      }
      return { ...config, configPath, roomId };
    }),
  );
  if (localConfigs.length === 2 && localConfigs[0].roomId !== localConfigs[1].roomId) {
    throw new Error("the two local configs use different rooms");
  }
  return localConfigs.map((item) => `${item.agentId}:${item.role}@${item.roomId}`).join(", ");
});

await check("Relay", async () => {
  if (!localConfigs.length) throw new Error("cannot determine relay without a valid config");
  const relayUrls = [...new Set(localConfigs.map((item) => item.relayUrl))];
  const summaries = [];
  for (const relayUrl of relayUrls) {
    const healthUrl = new URL(relayUrl);
    healthUrl.protocol = healthUrl.protocol === "wss:" ? "https:" : "http:";
    healthUrl.pathname = "/healthz";
    healthUrl.search = "";
    healthUrl.hash = "";
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`${healthUrl} returned HTTP ${response.status}`);
    const body = await response.json();
    summaries.push(`${healthUrl.host}: online, ${body.rooms} room(s)`);
  }
  return summaries.join(", ");
});

await check("Installed MCP client", async () => {
  const installations = [];
  const codexPath = path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "config.toml");
  const codex = await readOptional(codexPath);
  if (codex?.includes("[mcp_servers.agent-link]")) installations.push(`Codex: ${codexPath}`);

  const claudeDesktopPath = path.join(
    appDataDir,
    "Claude",
    "claude_desktop_config.json",
  );
  const claudeDesktop = await readOptional(claudeDesktopPath);
  if (claudeDesktop) {
    const parsed = JSON.parse(claudeDesktop);
    if (parsed.mcpServers?.["agent-link"]) installations.push(`Claude Desktop: ${claudeDesktopPath}`);
  }

  const claudeCodePath = path.join(homeDir, ".claude.json");
  const claudeCode = await readOptional(claudeCodePath);
  if (claudeCode) {
    const parsed = JSON.parse(claudeCode);
    if (parsed.mcpServers?.["agent-link"]) installations.push(`Claude Code: ${claudeCodePath}`);
  }

  if (!installations.length) throw new Error("AgentLink is not installed in Codex or Claude");
  return installations.join(", ");
});

await check("Local relay stderr", async () => {
  const file = path.join(configDir, "runtime", "relay.stderr.log");
  const text = await readOptional(file);
  if (text === null) return "not present (the relay may be remote)";
  if (text.trim()) throw new Error(text.trim().slice(0, 300));
  return "empty";
});

for (const item of results) {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.label}: ${item.detail}`);
}
if (results.some((item) => !item.ok)) process.exitCode = 1;
