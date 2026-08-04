import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentity, createRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(rootDir, "scripts", "new-session.js");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-session-test-"));
const initiatorPath = path.join(tempDir, "alice.json");
const responderPath = path.join(tempDir, "bob.json");
const initialIdentity = createIdentity();

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

try {
  await writeFile(initiatorPath, JSON.stringify({
    relayUrl: "ws://127.0.0.1:8787/ws",
    roomCode: createRoomCode(),
    agentId: "alice-codex",
    displayName: "Alice Codex",
    role: "initiator",
    identity: initialIdentity,
  }));
  await writeFile(responderPath, JSON.stringify({
    relayUrl: "ws://127.0.0.1:8787/ws",
    roomCode: createRoomCode(),
    agentId: "bob-claude",
    displayName: "Bob Claude",
    role: "responder",
    identity: createIdentity(),
  }));

  const output = execFileSync(process.execPath, [script, initiatorPath], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const roomCode = output.match(/room_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{32,}/)?.[0];
  assert(roomCode, "initiator rotation must print a room code");

  execFileSync(process.execPath, [script, "--code", roomCode, responderPath], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const initiator = await readJson(initiatorPath);
  const responder = await readJson(responderPath);
  assert.equal(initiator.roomCode, roomCode);
  assert.equal(responder.roomCode, roomCode);
  assert.equal(initiator.identity.privateKey, initialIdentity.privateKey);
  assert.equal((await readJson(`${initiatorPath}.state.json`)).phase, "negotiating_goal");
  assert.equal((await readJson(`${responderPath}.state.json`)).phase, "negotiating_goal");

  execFileSync(process.execPath, [script, initiatorPath, responderPath], {
    cwd: rootDir,
    encoding: "utf8",
  });
  assert.equal((await readJson(initiatorPath)).roomCode, (await readJson(responderPath)).roomCode);
  console.log("SESSION PASS: one-machine and two-machine room rotation verified");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
