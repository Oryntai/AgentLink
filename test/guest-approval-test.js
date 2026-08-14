import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { createIdentity, createRoomCode } from "../src/crypto.js";
import { DESKTOP_BROKER_METHODS } from "../src/protocol-version.js";

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

async function waitFor(what, read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const conversationFor = async (client, requestId) => {
  const { conversations } = await client.listConversations();
  return conversations.find((record) => record.requestId === requestId) || null;
};

process.env.AGENT_LINK_NOTIFY = "0";
process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = "1500";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-guest-test-"));
const port = await freePort();
const roomCode = createRoomCode();
const hostPath = path.join(tempDir, "host.json");
const guestPath = path.join(tempDir, "guest.json");

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

const brokerPids = new Set();
let hostWindow;
let hostAgent;
let guestWindow;
try {
  for (const [configPath, agentId, role, displayName] of [
    [hostPath, "host-codex", "initiator", "Host"],
    [guestPath, "guest-window", "responder", "Guest"],
  ]) {
    await writeFile(configPath, `${JSON.stringify({
      relayUrl: `ws://127.0.0.1:${port}/ws`,
      roomCode,
      agentId,
      displayName,
      role,
      identity: createIdentity(),
      logDir: path.join(tempDir, "logs", agentId),
    }, null, 2)}\n`);
  }

  const hostConfig = await loadBridgeConfig(hostPath);
  const guestConfig = await loadBridgeConfig(guestPath);

  // The owner's window and the owner's agent are two frontends of one broker.
  hostWindow = new BrokerClient(hostConfig, { requiredMethods: DESKTOP_BROKER_METHODS });
  await hostWindow.connect();
  brokerPids.add(hostWindow.status().broker.pid);
  hostAgent = new BrokerClient(hostConfig);
  await hostAgent.connect();

  // The guest has no agent at all: the window is its only frontend.
  guestWindow = new BrokerClient(guestConfig, { requiredMethods: DESKTOP_BROKER_METHODS });
  await guestWindow.connect();
  brokerPids.add(guestWindow.status().broker.pid);

  assert.equal(
    (await hostWindow.getPolicy()).approvals,
    "auto",
    "an existing installation must keep answering the way it did before",
  );
  assert.equal((await hostWindow.setPolicy("manual")).approvals, "manual");
  await assert.rejects(
    () => hostWindow.setPolicy("whatever"),
    /approvals must be one of/,
    "an unknown policy must be refused rather than silently disabling the gate",
  );

  // 1. A held request reaches the owner, and nothing else.
  const question = "look at user_id 42 in the users table and tell me its plan";
  const asked = await guestWindow.requestSend(question, { retainQuestion: true });
  const waiting = await waitFor("the request to reach the owner", async () => {
    const { waiting: pending } = await hostWindow.listApprovals();
    return pending.length ? pending : null;
  });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].question, question, "the owner must see what is being asked");
  assert.equal(waiting[0].requestId, asked.request_id);

  assert.deepEqual(
    await hostAgent.listInbox(),
    [],
    "a held request must not appear in the inbox the agent reads",
  );
  await assert.rejects(
    () => hostAgent.claimInbox(asked.request_id),
    /Queued request not found/,
    "a held request must not be claimable before the owner approves it",
  );
  await assert.rejects(
    () => hostAgent.wait({ kinds: ["request"], timeoutMs: 700 }),
    /No peer message/,
    "a listening agent must not be handed a held request",
  );

  const heldForGuest = await waitFor("the guest to be told it is waiting", async () => {
    const record = await conversationFor(guestWindow, asked.request_id);
    return record?.state === "held" ? record : null;
  });
  assert.equal(heldForGuest.question, question, "the guest must see what it asked");
  assert.equal(heldForGuest.answer, null);

  // 2. Approving hands it to the agent, and the answer reaches the guest.
  await hostWindow.decideApproval(asked.request_id, "approve");
  const inbox = await waitFor("the approved request in the inbox", async () => {
    const entries = await hostAgent.listInbox();
    return entries.length ? entries : null;
  });
  assert.equal(inbox[0].requestId, asked.request_id);
  assert.equal(inbox[0].text, question);
  await hostAgent.claimInbox(asked.request_id);
  await hostAgent.respond(asked.request_id, "user 42 is on the free plan");

  const answered = await waitFor("the answer to reach the guest", async () => {
    const record = await conversationFor(guestWindow, asked.request_id);
    return record?.state === "responded" ? record : null;
  });
  assert.equal(answered.answer, "user 42 is on the free plan");

  // 3. Denying ends the request, and the guest is told without a reason leak.
  const denied = await guestWindow.requestSend("delete the users table", { retainQuestion: true });
  await waitFor("the second request to reach the owner", async () => {
    const { waiting: pending } = await hostWindow.listApprovals();
    return pending.some((entry) => entry.requestId === denied.request_id) || null;
  });
  await hostWindow.decideApproval(denied.request_id, "deny");
  const refused = await waitFor("the guest to be told it was declined", async () => {
    const record = await conversationFor(guestWindow, denied.request_id);
    return record?.state === "declined" ? record : null;
  });
  assert.equal(refused.answer, null, "a declined request must not carry an answer");
  assert.deepEqual(
    await hostAgent.listInbox(),
    [],
    "a denied request must never become visible to the agent",
  );

  // 4. Switching back to automatic releases what is already waiting.
  const pendingWhenSwitched = await guestWindow.requestSend("how many rows in orders?", {
    retainQuestion: true,
  });
  await waitFor("the third request to be held", async () => {
    const { waiting: pending } = await hostWindow.listApprovals();
    return pending.some((entry) => entry.requestId === pendingWhenSwitched.request_id) || null;
  });
  const switched = await hostWindow.setPolicy("auto");
  assert.equal(switched.released, 1, "switching to automatic must not strand a held request");
  const released = await waitFor("the released request in the inbox", async () => {
    const entries = await hostAgent.listInbox();
    return entries.some((entry) => entry.requestId === pendingWhenSwitched.request_id)
      ? entries
      : null;
  });
  assert.equal(released.length, 1);
  assert.deepEqual((await hostWindow.listApprovals()).waiting, []);

  // 5. Under the automatic policy a new request is queued for the agent directly.
  const direct = await guestWindow.requestSend("which migrations ran today?", {
    retainQuestion: true,
  });
  await waitFor("the direct request in the inbox", async () => {
    const entries = await hostAgent.listInbox();
    return entries.some((entry) => entry.requestId === direct.request_id) || null;
  });
  assert.deepEqual((await hostWindow.listApprovals()).waiting, []);

  console.log("guest approval test passed");
} finally {
  await Promise.allSettled([hostWindow?.close(), hostAgent?.close(), guestWindow?.close()]);
  relay.kill();
  for (const pid of brokerPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The broker exited on its own.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  await rm(tempDir, { recursive: true, force: true });
}
