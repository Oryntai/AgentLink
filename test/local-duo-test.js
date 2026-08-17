import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRoomCode } from "../src/crypto.js";
import {
  claimLocalDuoProfile,
  loadLocalDuo,
  releaseLocalDuoProfile,
  saveLocalDuo,
} from "../src/local-duo.js";
import { writeParticipantConfig } from "../scripts/setup-lib.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-local-duo-test-"));

try {
  const roomCode = createRoomCode();
  const developer = await writeParticipantConfig({
    configDir: tempDir,
    relayUrl: "ws://127.0.0.1:8787/ws",
    roomCode,
    agentId: "local-developer",
    displayName: "Developer",
    role: "initiator",
    activate: false,
  });
  const reviewer = await writeParticipantConfig({
    configDir: tempDir,
    relayUrl: "ws://127.0.0.1:8787/ws",
    roomCode,
    agentId: "local-reviewer",
    displayName: "Reviewer",
    role: "responder",
    activate: false,
  });
  await saveLocalDuo(tempDir, {
    version: 1,
    roomName: "Build and review",
    relayUrl: "ws://127.0.0.1:8787/ws",
    createdAt: new Date().toISOString(),
    profiles: [
      {
        id: "developer",
        agentId: developer.config.agentId,
        displayName: developer.config.displayName,
        role: developer.config.role,
        workspace: tempDir,
        configPath: developer.configPath,
        claim: null,
      },
      {
        id: "reviewer",
        agentId: reviewer.config.agentId,
        displayName: reviewer.config.displayName,
        role: reviewer.config.role,
        workspace: tempDir,
        configPath: reviewer.configPath,
        claim: null,
      },
    ],
  });
  const duo = await loadLocalDuo(tempDir);
  assert.equal(duo.profiles.length, 2);
  assert.equal(duo.profiles[0].claim, null);
  const claimed = await claimLocalDuoProfile(tempDir, "developer");
  assert.equal(claimed.id, "developer");
  assert.equal((await loadLocalDuo(tempDir)).profiles[0].claim.pid, process.pid);
  assert.equal(await releaseLocalDuoProfile(tempDir, "developer"), true);
  assert.equal((await loadLocalDuo(tempDir)).profiles[0].claim, null);
  await assert.rejects(() => saveLocalDuo(tempDir, {
    ...duo,
    relayUrl: "wss://example.test/ws",
  }), /local ws:\/\/127\.0\.0\.1 relay/);
  console.log("LOCAL DUO PASS: independent local profiles and claims verified");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
