import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseRoomCode } from "./crypto.js";

export async function loadBridgeConfig(explicitPath) {
  const configPath = path.resolve(
    explicitPath || process.env.AGENT_LINK_CONFIG || ".agent-link/config.json",
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const required = ["relayUrl", "roomCode", "agentId", "displayName", "role"];
  for (const key of required) {
    if (!config[key]) throw new Error(`Missing ${key} in ${configPath}`);
  }
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(config.agentId)) {
    throw new Error("agentId may contain only letters, digits, _ and -");
  }
  if (!['initiator', 'responder'].includes(config.role)) {
    throw new Error("role must be initiator or responder");
  }
  if (!config.identity?.publicKey || !config.identity?.privateKey) {
    throw new Error(`Missing Ed25519 identity in ${configPath}; recreate or migrate this AgentLink config`);
  }
  if (config.expiresAt && Date.parse(config.expiresAt) <= Date.now()) {
    throw new Error(`AgentLink session expired at ${config.expiresAt}; create a new room`);
  }
  const { roomId, secret } = parseRoomCode(config.roomCode);
  return {
    ...config,
    channelMode: process.env.AGENT_LINK_CHANNEL_MODE === undefined
      ? Boolean(config.channelMode)
      : process.env.AGENT_LINK_CHANNEL_MODE === "1",
    roomId,
    secret,
    configPath,
    logDir: path.resolve(path.dirname(configPath), config.logDir || "logs"),
  };
}
