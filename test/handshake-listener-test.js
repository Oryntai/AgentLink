import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { BridgeClient } from "../src/bridge-client.js";
import {
  createIdentity,
  createRoomCode,
  encryptPayload,
  identityProof,
  messageId,
  parseRoomCode,
  signEnvelope,
} from "../src/crypto.js";

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

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-handshake-test-"));
const port = await freePort();
const roomCode = createRoomCode();
const { roomId, secret } = parseRoomCode(roomCode);
const peerIdentity = createIdentity();
const peerAgentId = "peer-codex";

const config = {
  relayUrl: `ws://127.0.0.1:${port}/ws`,
  roomCode,
  roomId,
  secret,
  configPath: path.join(tempDir, "listener.json"),
  agentId: "listener-claude",
  displayName: "Listener",
  role: "responder",
  identity: createIdentity(),
  logDir: path.join(tempDir, "logs"),
};

function queuedEnvelope(text) {
  const envelope = {
    version: 2,
    id: messageId(),
    roomId,
    from: peerAgentId,
    to: config.agentId,
    sentAt: new Date().toISOString(),
  };
  envelope.encrypted = encryptPayload(roomId, secret, { kind: "chat", text }, envelope);
  envelope.signature = signEnvelope(peerIdentity.privateKey, envelope);
  return envelope;
}

// A relay that flushes the offline queue in the same tick as the welcome, which
// is what the real relay does for a peer that was never in the room. Anything
// the client attaches after its handshake settles arrives too late.
const server = new WebSocketServer({ port, path: "/ws" });
server.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type !== "hello") return;
    socket.send(JSON.stringify({
      type: "welcome",
      roomId,
      role: message.role,
      peers: [{
        agentId: peerAgentId,
        publicKey: peerIdentity.publicKey,
        keyProof: identityProof(roomId, secret, peerAgentId, peerIdentity.publicKey),
      }],
    }));
    socket.send(JSON.stringify({ type: "message", envelope: queuedEnvelope("flushed with the welcome") }));
  });
});
await new Promise((resolve) => server.once("listening", resolve));

let bridge;
try {
  bridge = new BridgeClient(config);
  await bridge.connect();
  const received = await bridge.wait({ kinds: ["chat"], timeoutMs: 5_000 });
  assert.equal(received.text, "flushed with the welcome");
  assert.equal(received.from, peerAgentId);
  console.log("handshake listener test passed");
} finally {
  await bridge?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}
