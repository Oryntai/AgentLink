import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIdentity, parseRoomCode } from "../src/crypto.js";

export const supportedClients = new Set(["codex", "claude", "claude-desktop"]);

export function parseNamedArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (!option.startsWith("--")) throw new Error(`Unexpected argument: ${option}`);
    const key = option.slice(2);
    const next = values[index + 1];
    result[key] = next && !next.startsWith("--") ? values[++index] : "true";
  }
  return result;
}

export function validateAgentId(agentId) {
  if (!agentId || !/^[A-Za-z0-9_-]{2,64}$/.test(agentId)) {
    throw new Error("--agent is required and may contain only letters, digits, _ and -");
  }
  return agentId;
}

export function validateClient(client) {
  if (!client || !supportedClients.has(client)) {
    throw new Error("--client is required and must be codex, claude, or claude-desktop");
  }
  return client;
}

export function validateRelayUrl(value) {
  let relayUrl;
  try {
    relayUrl = new URL(value);
  } catch {
    throw new Error("--url must be a valid ws:// or wss:// relay URL");
  }
  if (!["ws:", "wss:"].includes(relayUrl.protocol)) {
    throw new Error("--url must use ws:// or wss://");
  }
  if (relayUrl.username || relayUrl.password) {
    throw new Error("Relay URLs must not contain credentials");
  }
  return relayUrl.toString();
}

export function publicTunnelToRelayUrl(value) {
  const tunnelUrl = new URL(value);
  if (!["http:", "https:"].includes(tunnelUrl.protocol)) {
    throw new Error(`ngrok returned an unsupported URL: ${value}`);
  }
  tunnelUrl.protocol = tunnelUrl.protocol === "https:" ? "wss:" : "ws:";
  tunnelUrl.pathname = "/ws";
  tunnelUrl.search = "";
  tunnelUrl.hash = "";
  return tunnelUrl.toString();
}

export function redactSecret(value, secret) {
  const text = String(value);
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

export async function writeParticipantConfig({
  configDir,
  relayUrl,
  roomCode,
  agentId,
  displayName,
  role,
  channelMode = false,
}) {
  validateAgentId(agentId);
  parseRoomCode(roomCode);
  if (!["initiator", "responder"].includes(role)) throw new Error("Invalid participant role");

  const configPath = path.join(configDir, `${agentId}.json`);
  let identity;
  try {
    const existing = JSON.parse(await readFile(configPath, "utf8"));
    if (existing.identity?.publicKey && existing.identity?.privateKey) identity = existing.identity;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const config = {
    relayUrl: validateRelayUrl(relayUrl),
    roomCode,
    agentId,
    displayName: displayName || agentId,
    role,
    channelMode: Boolean(channelMode),
    identity: identity || createIdentity(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    logDir: path.join("logs", agentId),
  };
  const statePath = `${configPath}.state.json`;
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    statePath,
    `${JSON.stringify({ phase: "negotiating_goal", goal: null, successCriteria: [] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { config, configPath, statePath };
}

export function installMcp({ rootDir, configPath, client }) {
  validateClient(client);
  const result = spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts", "install-mcp.js"), "--config", configPath, "--client", client],
    { cwd: rootDir, stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`MCP installation exited with code ${result.status}`);
}
