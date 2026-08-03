import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(rootDir, ".agent-link");
const results = [];

async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, label, detail });
  } catch (error) {
    results.push({ ok: false, label, detail: error.message });
  }
}

await check("Relay", async () => {
  const response = await fetch("http://127.0.0.1:8787/healthz", { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return `online, ${body.rooms} room(s)`;
});

await check("Codex Desktop config", async () => {
  const file = path.join(process.env.USERPROFILE, ".codex", "config.toml");
  const text = await readFile(file, "utf8");
  if (!text.includes("[mcp_servers.agent-link]")) throw new Error("agent-link block missing");
  return file;
});

await check("Claude Desktop config", async () => {
  const file = path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  if (!config.mcpServers?.["agent-link"]) throw new Error("agent-link server missing");
  return file;
});

await check("Local participant configs", async () => {
  const files = (await readdir(configDir)).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".state.json"),
  );
  if (files.length < 2) throw new Error(`expected 2, found ${files.length}`);
  const summaries = [];
  for (const name of files) {
    const config = JSON.parse(await readFile(path.join(configDir, name), "utf8"));
    const { roomId } = parseRoomCode(config.roomCode);
    summaries.push(`${config.agentId}:${config.role}@${roomId}`);
  }
  return summaries.join(", ");
});

await check("Relay stderr", async () => {
  const file = path.join(configDir, "runtime", "relay.stderr.log");
  await access(file);
  const text = await readFile(file, "utf8");
  if (text.trim()) throw new Error(text.trim().slice(0, 300));
  return "empty";
});

for (const item of results) {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.label}: ${item.detail}`);
}
if (results.some((item) => !item.ok)) process.exitCode = 1;
