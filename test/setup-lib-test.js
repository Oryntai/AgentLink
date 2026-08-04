import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRoomCode } from "../src/crypto.js";
import {
  publicTunnelToRelayUrl,
  redactSecret,
  validateRelayUrl,
  writeParticipantConfig,
} from "../scripts/setup-lib.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-setup-test-"));

try {
  assert.equal(
    publicTunnelToRelayUrl("https://temporary-example.ngrok.app"),
    "wss://temporary-example.ngrok.app/ws",
  );
  assert.equal(validateRelayUrl("ws://127.0.0.1:8787/ws"), "ws://127.0.0.1:8787/ws");
  assert.throws(() => validateRelayUrl("https://example.com/ws"), /must use ws/);
  assert.throws(() => validateRelayUrl("wss://user:secret@example.com/ws"), /credentials/);
  assert.equal(redactSecret("token=private-token", "private-token"), "token=[REDACTED]");

  const roomCode = createRoomCode();
  const { configPath, statePath, activeConfigPath, activeStatePath } = await writeParticipantConfig({
    configDir: tempDir,
    relayUrl: "wss://temporary-example.ngrok.app/ws",
    roomCode,
    agentId: "bob-claude",
    displayName: "Bob Claude",
    role: "responder",
  });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const activeConfig = JSON.parse(await readFile(activeConfigPath, "utf8"));
  const activeState = JSON.parse(await readFile(activeStatePath, "utf8"));
  assert.equal(config.roomCode, roomCode);
  assert.equal(config.role, "responder");
  assert.equal(config.relayUrl, "wss://temporary-example.ngrok.app/ws");
  assert(config.identity.publicKey.includes("BEGIN PUBLIC KEY"));
  assert(config.identity.privateKey.includes("BEGIN PRIVATE KEY"));
  assert.equal(state.phase, "negotiating_goal");
  assert.deepEqual(activeConfig, config);
  assert.equal(activeState.phase, "negotiating_goal");
  assert.equal(path.basename(activeConfigPath), "active.json");
  assert.doesNotMatch(configPath, /room_/);

  const originalIdentity = config.identity;
  await writeParticipantConfig({
    configDir: tempDir,
    relayUrl: "wss://another-temporary-example.ngrok.app/ws",
    roomCode: createRoomCode(),
    agentId: "bob-claude",
    displayName: "Bob Claude",
    role: "responder",
  });
  const rotated = JSON.parse(await readFile(configPath, "utf8"));
  const rotatedActive = JSON.parse(await readFile(activeConfigPath, "utf8"));
  assert.deepEqual(rotated.identity, originalIdentity);
  assert.deepEqual(rotatedActive.identity, originalIdentity);
  assert.equal(rotatedActive.relayUrl, "wss://another-temporary-example.ngrok.app/ws");
  console.log("SETUP PASS: participant identity and permanent active config verified");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
