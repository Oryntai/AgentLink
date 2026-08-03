import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../src/bridge-client.js";
import { decryptLogRecord } from "../src/log-crypto.js";
import {
  createIdentity,
  createRoomCode,
  encryptPayload,
  identityProof,
  parseRoomCode,
  signEnvelope,
  verifyIdentityProof,
  verifyEnvelope,
} from "../src/crypto.js";

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

async function waitForRelay(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Relay did not start")), 10_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("AgentLink relay listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited early with ${code}: ${output}`));
    });
  });
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-test-"));
const port = await freePort();
const dataFile = path.join(tempDir, "relay-state.json");
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
  displayName: "Alice Codex",
  role: "initiator",
  identity: createIdentity(),
};
const bobConfig = {
  ...base,
  configPath: path.join(tempDir, "bob.json"),
  agentId: "bob-claude",
  displayName: "Bob Claude",
  role: "responder",
  identity: createIdentity(),
};

const signedEnvelope = {
  version: 2,
  id: "signature-test",
  roomId,
  from: aliceConfig.agentId,
  to: bobConfig.agentId,
  sentAt: new Date().toISOString(),
};
signedEnvelope.encrypted = encryptPayload(roomId, secret, { kind: "chat", text: "signed" }, signedEnvelope);
signedEnvelope.signature = signEnvelope(aliceConfig.identity.privateKey, signedEnvelope);
assert.equal(verifyEnvelope(aliceConfig.identity.publicKey, signedEnvelope), true);
assert.equal(
  verifyEnvelope(aliceConfig.identity.publicKey, { ...signedEnvelope, from: "forged-agent" }),
  false,
);
const aliceProof = identityProof(
  roomId,
  secret,
  aliceConfig.agentId,
  aliceConfig.identity.publicKey,
);
assert.equal(
  verifyIdentityProof(
    roomId,
    secret,
    aliceConfig.agentId,
    aliceConfig.identity.publicKey,
    aliceProof,
  ),
  true,
);
assert.equal(
  verifyIdentityProof(roomId, secret, "forged-agent", aliceConfig.identity.publicKey, aliceProof),
  false,
);

const relay = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
  cwd: rootDir,
  env: {
    ...process.env,
    AGENT_LINK_HOST: "127.0.0.1",
    AGENT_LINK_PORT: String(port),
    AGENT_LINK_DATA_FILE: dataFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let alice;
let bob;
let bobReconnected;
try {
  await waitForRelay(relay);
  alice = new BridgeClient(aliceConfig);
  bob = new BridgeClient(bobConfig);
  await Promise.all([alice.connect(), bob.connect()]);

  await alice.send("Согласовать структуру кнопки", {
    kind: "goal_proposal",
    metadata: {
      displayName: "Alice Codex",
      successCriteria: ["Определить контракт", "Разделить задачи"],
    },
  });
  const proposal = await bob.wait({ kinds: ["goal_proposal"], timeoutMs: 2_000 });
  assert.equal(proposal.text, "Согласовать структуру кнопки");
  await bob.send("Цель подтверждена", {
    kind: "goal_accept",
    metadata: { displayName: "Bob Claude" },
  });
  const acceptance = await alice.wait({ kinds: ["goal_accept"], timeoutMs: 2_000 });
  assert.equal(acceptance.text, "Цель подтверждена");

  const [fromBob, fromAlice] = await Promise.all([
    alice.exchange("Как назовём компонент?", {
      kind: "chat",
      metadata: { displayName: "Alice Codex" },
      timeoutMs: 2_000,
    }),
    bob.exchange("Какие состояния кнопки нужны?", {
      kind: "chat",
      metadata: { displayName: "Bob Claude" },
      timeoutMs: 2_000,
    }),
  ]);
  assert.equal(fromBob.text, "Какие состояния кнопки нужны?");
  assert.equal(fromAlice.text, "Как назовём компонент?");

  await bob.close();
  bob = null;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await alice.send("Сообщение, отправленное пока peer offline", {
    kind: "chat",
    metadata: { displayName: "Alice Codex" },
  });
  bobReconnected = new BridgeClient(bobConfig);
  await bobReconnected.connect();
  const queued = await bobReconnected.wait({ kinds: ["chat"], timeoutMs: 2_000 });
  assert.equal(queued.text, "Сообщение, отправленное пока peer offline");

  await alice.send("План согласован: контракт и задачи определены", {
    kind: "finish_proposal",
    metadata: { displayName: "Alice Codex" },
  });
  const finish = await bobReconnected.wait({ kinds: ["finish_proposal"], timeoutMs: 2_000 });
  assert.match(finish.text, /План согласован/);
  await bobReconnected.send("Завершение подтверждено", {
    kind: "finish_accept",
    metadata: { displayName: "Bob Claude" },
  });
  const finished = await alice.wait({ kinds: ["finish_accept"], timeoutMs: 2_000 });
  assert.equal(finished.kind, "finish_accept");

  await alice.send(`Секрет не должен попасть в лог: ${roomCode}`, {
    kind: "chat",
    metadata: { displayName: "Alice Codex" },
  });
  const redactedMessage = await bobReconnected.wait({ kinds: ["chat"], timeoutMs: 2_000 });
  assert.match(redactedMessage.text, /Секрет не должен/);

  const replacement = new BridgeClient(aliceConfig);
  await replacement.connect();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alice.status().superseded, true);
  assert.equal(replacement.status().connected, true);
  await replacement.close();

  await new Promise((resolve) => setTimeout(resolve, 150));
  await Promise.all([alice.log.flush(), bobReconnected.log.flush()]);
  const aliceLog = await readFile(alice.log.filePath, "utf8");
  const decryptedAliceLog = aliceLog
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => decryptLogRecord(aliceConfig.identity.privateKey, JSON.parse(line)));
  const relayState = await readFile(dataFile, "utf8");
  assert.doesNotMatch(aliceLog, /Как назовём компонент/);
  assert.match(JSON.stringify(decryptedAliceLog), /Как назовём компонент/);
  assert.doesNotMatch(aliceLog, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(relayState, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  console.log("SMOKE PASS: encryption, simultaneous exchange, offline queue, completion, redaction, and single-owner reconnect verified");
  console.log(`TEST_LOG_DIR=${path.join(tempDir, "logs")}`);
} finally {
  await Promise.allSettled([alice?.close(), bob?.close(), bobReconnected?.close()]);
  relay.kill("SIGTERM");
  await new Promise((resolve) => relay.once("exit", resolve));
  if (!process.env.KEEP_AGENT_LINK_TEST_DATA) await rm(tempDir, { recursive: true, force: true });
}
