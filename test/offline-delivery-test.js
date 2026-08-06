import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../src/bridge-client.js";
import { createIdentity, createRoomCode, parseRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-offline-test-"));
const port = await freePort();
const roomCode = createRoomCode();
const { roomId, secret } = parseRoomCode(roomCode);
const base = {
  relayUrl: `ws://127.0.0.1:${port}/ws`,
  roomCode,
  roomId,
  secret,
  logDir: path.join(tempDir, "logs"),
};
const aliceConfig = {
  ...base,
  configPath: path.join(tempDir, "alice.json"),
  agentId: "alice-codex",
  displayName: "Alice",
  role: "initiator",
  identity: createIdentity(),
};
const bobConfig = {
  ...base,
  configPath: path.join(tempDir, "bob.json"),
  agentId: "bob-claude",
  displayName: "Bob",
  role: "responder",
  identity: createIdentity(),
};

const relay = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
  cwd: rootDir,
  env: {
    ...process.env,
    AGENT_LINK_HOST: "127.0.0.1",
    AGENT_LINK_PORT: String(port),
    AGENT_LINK_DATA_FILE: path.join(tempDir, "relay-state.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Relay did not start")), 10_000);
  relay.stdout.on("data", (chunk) => {
    if (chunk.toString("utf8").includes("AgentLink relay listening")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

let alice;
let bob;
try {
  alice = new BridgeClient(aliceConfig);
  await alice.connect();

  // Sent while the peer has never been in the room: the relay holds these and
  // flushes them in one burst immediately after that peer's welcome, so the
  // receiving side has to be listening before its own handshake settles.
  const queued = 6;
  for (let index = 0; index < queued; index += 1) {
    await alice.send(`queued before the peer ever joined ${index}`, { kind: "chat" });
  }

  bob = new BridgeClient(bobConfig);
  await bob.connect();
  const delivered = [];
  for (let index = 0; index < queued; index += 1) {
    delivered.push((await bob.wait({ kinds: ["chat"], timeoutMs: 10_000 })).text);
  }
  assert.deepEqual(
    delivered.sort(),
    Array.from({ length: queued }, (_, index) => `queued before the peer ever joined ${index}`).sort(),
    "every message queued before the peer existed must survive the handshake",
  );

  // The same must hold for a peer that has been in the room before and is
  // offline when the message is sent.
  await bob.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await alice.send("queued while the peer was away", { kind: "chat" });

  bob = new BridgeClient(bobConfig);
  await bob.connect();
  const second = await bob.wait({ kinds: ["chat"], timeoutMs: 10_000 });
  assert.equal(second.text, "queued while the peer was away");

  console.log("offline delivery test passed");
} finally {
  await Promise.allSettled([alice?.close(), bob?.close()]);
  relay.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(tempDir, { recursive: true, force: true });
}
