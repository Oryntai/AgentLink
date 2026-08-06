import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrokerClient } from "../src/broker-client.js";
import { listAgentConfigs } from "../src/agent-configs.js";
import { loadBridgeConfig } from "../src/config.js";
import { createIdentity, createRoomCode, parseRoomCode } from "../src/crypto.js";
import { DESKTOP_BROKER_METHODS } from "../src/protocol-version.js";

process.env.AGENT_LINK_NOTIFY = "0";
process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = "500";

const brokerPids = new Set();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function makeMachine(prefix, agents) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const roomCode = createRoomCode();
  for (const agent of agents) {
    await writeFile(path.join(dir, `${agent.agentId}.json`), JSON.stringify({
      relayUrl: "ws://127.0.0.1:1/ws",
      roomCode,
      agentId: agent.agentId,
      displayName: agent.agentId,
      role: agent.role,
      identity: createIdentity(),
      logDir: "logs",
    }, null, 2));
  }
  // Derived files sit next to configs and must never be mistaken for one.
  await writeFile(path.join(dir, "noise.json.trust.json"), JSON.stringify({ peers: {} }));
  await writeFile(path.join(dir, "notes.json"), JSON.stringify({ hello: "not a config" }));
  return { dir, roomCode };
}

async function readConfigs(dir) {
  const found = await listAgentConfigs(dir);
  return Object.fromEntries(found.map((entry) => [entry.config.agentId, entry.config]));
}

const machines = [];
try {
  const host = await makeMachine("agent-link-room-host-", [
    { agentId: "codex-local", role: "initiator" },
    { agentId: "claude-local", role: "responder" },
  ]);
  machines.push(host);

  const discovered = await listAgentConfigs(host.dir);
  assert.equal(discovered.length, 2, "only real participant configs are discovered");

  const hostClient = new BrokerClient(
    await loadBridgeConfig(path.join(host.dir, "codex-local.json")),
    { requiredMethods: DESKTOP_BROKER_METHODS },
  );
  await hostClient.connect();
  brokerPids.add(hostClient.status().broker.pid);

  const before = await readConfigs(host.dir);
  const created = await hostClient.createRoom("Project X");
  assert.equal(created.roomName, "Project X");
  assert.equal(created.agents.length, 2, "every agent on the machine is switched");

  const after = await readConfigs(host.dir);
  const newRoom = after["codex-local"].roomCode;
  assert.notEqual(newRoom, host.roomCode, "a new room really is a new room");
  assert.equal(
    after["claude-local"].roomCode,
    newRoom,
    "both agents must land in the same room, or one talks to nobody",
  );
  assert.equal(after["codex-local"].roomName, "Project X");
  assert.equal(after["codex-local"].role, "initiator", "sides are preserved");
  assert.equal(after["claude-local"].role, "responder");
  assert.equal(
    after["codex-local"].identity.privateKey,
    before["codex-local"].identity.privateKey,
    "identity survives a room change",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(host.dir, "noise.json.trust.json"), "utf8")).peers !== undefined,
    true,
    "derived files are left alone",
  );

  const invite = await hostClient.createInvite({ label: "Project X" });
  assert.match(invite.code, /^al1\./);
  assert.equal((await hostClient.listInvites()).invites[0].state, "pending");

  // The other machine joins by that code alone: room, relay and name all come
  // out of the invite, and only the joining side carries the invite id.
  const guest = await makeMachine("agent-link-room-guest-", [
    { agentId: "guest-claude", role: "responder" },
  ]);
  machines.push(guest);
  const guestClient = new BrokerClient(
    await loadBridgeConfig(path.join(guest.dir, "guest-claude.json")),
    { requiredMethods: DESKTOP_BROKER_METHODS },
  );
  await guestClient.connect();
  brokerPids.add(guestClient.status().broker.pid);

  const joined = await guestClient.joinRoom(invite.code);
  assert.equal(joined.roomName, "Project X");
  const guestConfigs = await readConfigs(guest.dir);
  assert.equal(
    parseRoomCode(guestConfigs["guest-claude"].roomCode).roomId,
    parseRoomCode(newRoom).roomId,
    "the guest lands in the host's room",
  );
  assert.equal(guestConfigs["guest-claude"].inviteId, invite.inviteId);
  assert.equal(guestConfigs["guest-claude"].role, "responder");
  assert.equal((await readConfigs(host.dir))["codex-local"].inviteId, undefined,
    "the issuer never carries an invite id");

  await assert.rejects(guestClient.joinRoom("al1.not-a-real-code.xx"), /checksum|al1 format/);

  await hostClient.close();
  await guestClient.close();
  console.log("room switch test passed");
} finally {
  for (const pid of brokerPids) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const machine of machines) await rm(machine.dir, { recursive: true, force: true });
}
