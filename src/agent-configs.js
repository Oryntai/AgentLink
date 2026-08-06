import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import { parseRoomCode } from "./crypto.js";

// Files the broker derives from a participant config. They live next to it and
// must never be mistaken for one.
const derived = /\.(trust|broker|state|invites|broker-runtime)\.json$/;

function isParticipantConfig(value) {
  return Boolean(
    value
    && typeof value === "object"
    && value.agentId
    && value.roomCode
    && value.identity?.privateKey
    && value.role,
  );
}

// Every agent on this machine runs against its own config file, and the MCP
// servers were launched with those paths. Changing a room in one file only
// would leave the other agent in the old room, looking connected and hearing
// nothing, so a room change has to reach all of them.
export async function listAgentConfigs(configDir) {
  const entries = await readdir(configDir).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || derived.test(entry)) continue;
    const filePath = path.join(configDir, entry);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (isParticipantConfig(parsed)) found.push({ filePath, config: parsed });
    } catch {
      // Not a participant config; leave it alone.
    }
  }
  return found.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function nextRole(existing, index) {
  if (existing === "initiator" || existing === "responder") return existing;
  return index === 0 ? "initiator" : "responder";
}

// Rewrites the room across every agent config, keeping each agent's identity,
// name and side of the link. Returns the files that actually changed.
export async function applyRoom(configDir, { roomCode, roomName, relayUrl, inviteId }) {
  parseRoomCode(roomCode);
  const agents = await listAgentConfigs(configDir);
  if (!agents.length) throw new Error(`No AgentLink agent configs found in ${configDir}`);
  const updated = [];
  for (const [index, agent] of agents.entries()) {
    const role = nextRole(agent.config.role, index);
    const next = {
      ...agent.config,
      roomCode,
      roomName: roomName || agent.config.roomName || null,
      role,
      relayUrl: relayUrl || agent.config.relayUrl,
    };
    // Only the joining side redeems an invite; the issuer has nothing to prove.
    if (inviteId && role === "responder") next.inviteId = inviteId;
    else delete next.inviteId;
    await writeFileAtomic(agent.filePath, `${JSON.stringify(next, null, 2)}\n`);
    updated.push({ filePath: agent.filePath, agentId: next.agentId, role });
  }
  return updated;
}
