import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { createIdentity, createRoomCode, parseRoomCode } from "../src/crypto.js";
import { decryptLogValue } from "../src/log-crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpScript = path.join(rootDir, "src", "mcp-server.js");

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
    child.once("exit", (code) => reject(new Error(`Relay exited early: ${code}\n${output}`)));
  });
}

function textOf(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

async function makeClient(name, configPath, onChannel) {
  const client = new Client(
    { name, version: "0.1.0" },
    { capabilities: { experimental: { "claude/channel": {} } } },
  );
  if (onChannel) {
    const ChannelSchema = z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()).optional(),
      }),
    });
    client.setNotificationHandler(ChannelSchema, onChannel);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpScript, configPath],
    cwd: rootDir,
    stderr: "pipe",
    env: {
      ...process.env,
      AGENT_LINK_NOTIFY: "0",
      AGENT_LINK_BROKER_IDLE_EXIT_MS: "100",
    },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-mcp-test-"));
const port = await freePort();
const relayUrl = `ws://127.0.0.1:${port}/ws`;
const roomCode = createRoomCode();
const alicePath = path.join(tempDir, "alice.json");
const bobPath = path.join(tempDir, "bob.json");
const aliceIdentity = createIdentity();
const bobIdentity = createIdentity();
const aliceConfig = {
  relayUrl,
  roomCode,
  agentId: "alice-codex",
  displayName: "Alice Codex",
  role: "initiator",
  identity: aliceIdentity,
  channelMode: false,
  logDir: "logs/alice",
};
const bobConfig = {
  relayUrl,
  roomCode,
  agentId: "bob-claude",
  displayName: "Bob Claude",
  role: "responder",
  identity: bobIdentity,
  channelMode: true,
  logDir: "logs/bob",
};
await writeFile(alicePath, JSON.stringify(aliceConfig));
await writeFile(bobPath, JSON.stringify(bobConfig));

const relay = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
  cwd: rootDir,
  env: {
    ...process.env,
    AGENT_LINK_HOST: "127.0.0.1",
    AGENT_LINK_PORT: "",
    PORT: String(port),
    AGENT_LINK_DATA_FILE: path.join(tempDir, "relay-state.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let alice;
let aliceSecond;
let bob;
let bobSecond;
let bobWatcher;
const channelEvents = [];
try {
  await waitForRelay(relay);
  alice = await makeClient("alice-test", alicePath);
  bob = await makeClient("bob-test", bobPath, (notification) => {
    channelEvents.push(notification.params);
  });

  const aliceTools = await alice.client.listTools();
  assert(aliceTools.tools.some((tool) => tool.name === "peer_exchange"));
  assert(aliceTools.tools.some((tool) => tool.name === "peer_inbox_claim"));
  assert(aliceTools.tools.some((tool) => tool.name === "peer_request_send"));
  assert(aliceTools.tools.some((tool) => tool.name === "peer_request_status"));

  const goalListener = bob.client.callTool({
    name: "peer_goal",
    arguments: { action: "wait", timeout_seconds: 10 },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const propose = alice.client.callTool({
    name: "peer_goal",
    arguments: {
      action: "propose",
      goal: "Agree on the button interface",
      success_criteria: ["Name", "States"],
      timeout_seconds: 10,
    },
  });
  const waitedGoal = await goalListener;
  assert.match(textOf(waitedGoal), /Agree on the button interface/);
  const accepted = await bob.client.callTool({
    name: "peer_goal",
    arguments: { action: "accept", note: "Goal and criteria accepted" },
  });
  assert.match(textOf(accepted), /Goal accepted/);
  assert.match(textOf(await propose), /accepted the goal/);

  const aliceExchange = alice.client.callTool({
    name: "peer_exchange",
    arguments: { message: "What should we call the component?", timeout_seconds: 10 },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(channelEvents.some((event) => /What should we call the component/.test(event.content)));
  await bob.client.callTool({
    name: "peer_reply",
    arguments: { message: "Call the component PaymentButton" },
  });
  assert.match(textOf(await aliceExchange), /PaymentButton/);

  const finishProposal = alice.client.callTool({
    name: "peer_complete",
    arguments: {
      action: "propose",
      summary: "The name and states are agreed",
      timeout_seconds: 10,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(channelEvents.some((event) => /proposes completing the current goal/.test(event.content)));
  await bob.client.callTool({
    name: "peer_complete",
    arguments: { action: "accept", note: "Completion confirmed" },
  });
  assert.match(textOf(await finishProposal), /confirmed goal completion/);

  const status = await alice.client.callTool({ name: "peer_status", arguments: {} });
  assert.match(textOf(status), /finished/);
  assert.equal(status.structuredContent.connected, true);
  assert.equal(status.structuredContent.persistent, true);
  assert.equal(status.structuredContent.hotReload, true);
  const bobStatus = await bob.client.callTool({ name: "peer_status", arguments: {} });
  assert.equal(bobStatus.structuredContent.connected, true);

  const firstAsk = alice.client.callTool({
    name: "peer_ask",
    arguments: { question: "Which database column stores the label?", timeout_seconds: 10 },
  });
  const firstRequest = await bob.client.callTool({
    name: "peer_listen",
    arguments: { timeout_seconds: 10 },
  });
  assert.match(textOf(firstRequest), /Which database column stores the label/);
  const firstRequestId = firstRequest.structuredContent.request.id;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bob.client.callTool({
    name: "peer_respond",
    arguments: {
      request_id: firstRequestId,
      message: "The read-only schema inspection shows the column is display_label",
    },
  });
  assert.match(textOf(await firstAsk), /display_label/);

  const asyncRequestId = "async-request-status-001";
  const sentAsync = await alice.client.callTool({
    name: "peer_request_send",
    arguments: {
      question: "Find the async setting while I continue local work",
      request_id: asyncRequestId,
    },
  });
  assert.match(sentAsync.structuredContent.status.state, /relay_acked|queued/);
  const outstanding = await alice.client.callTool({
    name: "peer_request_status",
    arguments: {},
  });
  assert.match(textOf(outstanding), /Find the async setting/);
  assert.doesNotMatch(textOf(outstanding), /async_setting_value/);
  aliceSecond = await makeClient("alice-second-task", alicePath);
  const otherTaskDefault = await aliceSecond.client.callTool({
    name: "peer_request_status",
    arguments: {},
  });
  assert.doesNotMatch(textOf(otherTaskDefault), new RegExp(asyncRequestId));
  const otherTaskAll = await aliceSecond.client.callTool({
    name: "peer_request_status",
    arguments: { all_tasks: true },
  });
  assert.match(textOf(otherTaskAll), new RegExp(asyncRequestId));
  await aliceSecond.client.close();
  aliceSecond = null;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const statusLongPoll = alice.client.callTool({
    name: "peer_request_status",
    arguments: { request_id: asyncRequestId, wait_seconds: 10 },
  });
  const asyncIncoming = await bob.client.callTool({
    name: "peer_listen",
    arguments: { timeout_seconds: 10 },
  });
  const changedStatus = await statusLongPoll;
  assert.match(changedStatus.structuredContent.status.state, /claimed|processing/);
  await bob.client.callTool({
    name: "peer_respond",
    arguments: {
      request_id: asyncIncoming.structuredContent.request.id,
      message: "The async_setting_value is enabled",
    },
  });
  const readySweep = await alice.client.callTool({
    name: "peer_request_status",
    arguments: {},
  });
  assert.match(textOf(readySweep), new RegExp(asyncRequestId));
  assert.match(textOf(readySweep), /responded/);
  assert.doesNotMatch(textOf(readySweep), /async_setting_value/);
  const collected = await alice.client.callTool({
    name: "peer_request_status",
    arguments: { request_id: asyncRequestId },
  });
  assert.match(textOf(collected), /async_setting_value/);
  assert.equal(collected.structuredContent.status.acknowledged, true);
  const afterCollect = await alice.client.callTool({
    name: "peer_request_status",
    arguments: {},
  });
  assert.doesNotMatch(textOf(afterCollect), new RegExp(asyncRequestId));
  const acknowledged = await alice.client.callTool({
    name: "peer_request_status",
    arguments: { include_acknowledged: true },
  });
  assert.match(textOf(acknowledged), new RegExp(asyncRequestId));
  const aliceBrokerFile = (await readdir(tempDir)).find(
    (name) => name.startsWith("alice.json.room_") && name.endsWith(".broker.json"),
  );
  const encryptedBrokerStore = await readFile(path.join(tempDir, aliceBrokerFile), "utf8");
  assert.doesNotMatch(encryptedBrokerStore, /async_setting_value|Find the async setting/);

  const orphanRequestId = "orphaned-response-status-001";
  await alice.client.callTool({
    name: "peer_request_send",
    arguments: {
      question: "Return an answer after the owning task exits",
      request_id: orphanRequestId,
    },
  });
  const orphanIncoming = await bob.client.callTool({
    name: "peer_listen",
    arguments: { timeout_seconds: 10 },
  });
  aliceSecond = await makeClient("alice-orphan-recovery-task", alicePath);
  await alice.client.close();
  alice = null;
  await bob.client.callTool({
    name: "peer_respond",
    arguments: {
      request_id: orphanIncoming.structuredContent.request.id,
      message: "Orphaned response remains recoverable",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const orphanDefaultSweep = await aliceSecond.client.callTool({
    name: "peer_request_status",
    arguments: {},
  });
  assert.doesNotMatch(textOf(orphanDefaultSweep), new RegExp(orphanRequestId));
  const orphanOwnerInbox = await aliceSecond.client.callTool({
    name: "peer_request_status",
    arguments: { all_tasks: true },
  });
  assert.match(textOf(orphanOwnerInbox), new RegExp(orphanRequestId));
  assert.match(textOf(orphanOwnerInbox), /responded/);
  const orphanStoreEnvelope = JSON.parse(
    await readFile(path.join(tempDir, aliceBrokerFile), "utf8"),
  );
  const orphanStore = decryptLogValue(aliceIdentity.privateKey, orphanStoreEnvelope.payload);
  assert(orphanStore.outbound[orphanRequestId].uncollectedNotifiedAt);
  assert.equal(orphanStore.outbound[orphanRequestId].acknowledgedAt, undefined);
  const recoveredOrphan = await aliceSecond.client.callTool({
    name: "peer_request_status",
    arguments: { request_id: orphanRequestId },
  });
  assert.match(textOf(recoveredOrphan), /Orphaned response remains recoverable/);
  alice = aliceSecond;
  aliceSecond = null;

  const timedAsk = await alice.client.callTool({
    name: "peer_ask",
    arguments: { question: "Recover me after the blocking wait times out", timeout_seconds: 1 },
  });
  assert.match(textOf(timedAsk), /Continue later with peer_request_status/);
  const timedRequestId = timedAsk.structuredContent.requestId;
  const timedClaim = await bob.client.callTool({
    name: "peer_inbox_claim",
    arguments: { request_id: timedRequestId },
  });
  assert.match(textOf(timedClaim), /Recover me/);
  await bob.client.callTool({
    name: "peer_respond",
    arguments: { request_id: timedRequestId, message: "Recovered after timeout" },
  });
  const recovered = await alice.client.callTool({
    name: "peer_request_status",
    arguments: { request_id: timedRequestId },
  });
  assert.match(textOf(recovered), /Recovered after timeout/);

  const stableRequestId = "inbox-dedupe-request-001";
  const inboxAsk = alice.client.callTool({
    name: "peer_ask",
    arguments: {
      question: "Which table owns the checkout label?",
      request_id: stableRequestId,
      timeout_seconds: 10,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const inbox = await bob.client.callTool({ name: "peer_inbox_list", arguments: {} });
  assert.match(textOf(inbox), /Which table owns the checkout label/);
  assert.equal(inbox.structuredContent.requests[0].requestId, stableRequestId);
  const claimed = await bob.client.callTool({
    name: "peer_inbox_claim",
    arguments: { request_id: stableRequestId },
  });
  assert.match(textOf(claimed), /Which table owns/);
  await bob.client.callTool({
    name: "peer_respond",
    arguments: { request_id: stableRequestId, message: "The table is checkout_settings" },
  });
  assert.match(textOf(await inboxAsk), /checkout_settings/);
  const replayedAsk = await alice.client.callTool({
    name: "peer_ask",
    arguments: {
      question: "Which table owns the checkout label?",
      request_id: stableRequestId,
      timeout_seconds: 10,
    },
  });
  assert.match(textOf(replayedAsk), /checkout_settings/);

  bobWatcher = new BrokerClient(await loadBridgeConfig(bobPath));
  await bobWatcher.connect();
  const watcherWake = bobWatcher.watch(10_000);
  const watcherRequestId = "watcher-request-001";
  const watcherAsk = alice.client.callTool({
    name: "peer_ask",
    arguments: {
      question: "Wake a nonblocking owner-side watcher",
      request_id: watcherRequestId,
      timeout_seconds: 10,
    },
  });
  const wakeMetadata = await watcherWake;
  assert.equal(wakeMetadata.requestId, watcherRequestId);
  const watcherClaim = await bob.client.callTool({
    name: "peer_inbox_claim",
    arguments: { request_id: watcherRequestId },
  });
  assert.match(textOf(watcherClaim), /nonblocking owner-side watcher/);
  await bob.client.callTool({
    name: "peer_respond",
    arguments: { request_id: watcherRequestId, message: "Watcher woke without claiming the body" },
  });
  assert.match(textOf(await watcherAsk), /without claiming/);
  await bobWatcher.close();
  bobWatcher = null;

  const nextListen = bob.client.callTool({
    name: "peer_listen",
    arguments: { timeout_seconds: 10 },
  });
  const secondAsk = alice.client.callTool({
    name: "peer_ask",
    arguments: { question: "Which values are present in that column?", timeout_seconds: 10 },
  });
  const secondRequest = await nextListen;
  await bob.client.callTool({
    name: "peer_respond",
    arguments: {
      request_id: secondRequest.structuredContent.request.id,
      message: "The requested row contains Checkout",
    },
  });
  assert.match(textOf(await secondAsk), /Checkout/);

  const askFromAlice = alice.client.callTool({
    name: "peer_ask",
    arguments: { question: "Alice asks for Bob's requirement", timeout_seconds: 10 },
  });
  const askFromBob = bob.client.callTool({
    name: "peer_ask",
    arguments: { question: "Bob asks for Alice's component name", timeout_seconds: 10 },
  });
  const [requestAtAlice, requestAtBob] = await Promise.all([
    alice.client.callTool({ name: "peer_listen", arguments: { timeout_seconds: 10 } }),
    bob.client.callTool({ name: "peer_listen", arguments: { timeout_seconds: 10 } }),
  ]);
  await Promise.all([
    alice.client.callTool({
      name: "peer_respond",
      arguments: {
        request_id: requestAtAlice.structuredContent.request.id,
        message: "Alice-only answer: PaymentButton",
      },
    }),
    bob.client.callTool({
      name: "peer_respond",
      arguments: {
        request_id: requestAtBob.structuredContent.request.id,
        message: "Bob-only answer: audit logging is required",
      },
    }),
  ]);
  assert.match(textOf(await askFromAlice), /Bob-only answer/);
  assert.match(textOf(await askFromBob), /Alice-only answer/);

  bobSecond = await makeClient("bob-second-task", bobPath);
  const firstClaim = bob.client.callTool({
    name: "peer_listen",
    arguments: { timeout_seconds: 5 },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const secondClaim = bobSecond.client.callTool({
    name: "peer_listen",
    arguments: { timeout_seconds: 1 },
  });
  const routedAsk = alice.client.callTool({
    name: "peer_ask",
    arguments: { question: "Which waiting task receives this?", timeout_seconds: 10 },
  });
  const routedRequest = await firstClaim;
  assert.match(textOf(routedRequest), /Which waiting task/);
  await bob.client.callTool({
    name: "peer_respond",
    arguments: {
      request_id: routedRequest.structuredContent.request.id,
      message: "The oldest explicit claim received it",
    },
  });
  assert.match(textOf(await routedAsk), /oldest explicit claim/);
  assert.match(textOf(await secondClaim), /No peer message/);
  const multiFrontendStatus = await bob.client.callTool({ name: "peer_status", arguments: {} });
  assert(multiFrontendStatus.structuredContent.frontends >= 2);
  await bobSecond.client.close();
  bobSecond = null;

  const rotatedRoomCode = createRoomCode();
  const resetState = JSON.stringify({ phase: "negotiating_goal", goal: null, successCriteria: [] });
  const rotatedRoomId = parseRoomCode(rotatedRoomCode).roomId;
  await Promise.all([
    writeFile(`${alicePath}.${rotatedRoomId}.state.json`, resetState),
    writeFile(`${bobPath}.${rotatedRoomId}.state.json`, resetState),
  ]);
  await writeFile(alicePath, JSON.stringify({ ...aliceConfig, roomCode: rotatedRoomCode }));
  await writeFile(bobPath, JSON.stringify({ ...bobConfig, roomCode: rotatedRoomCode }));
  await new Promise((resolve) => setTimeout(resolve, 750));

  const rotatedAliceStatus = await alice.client.callTool({ name: "peer_status", arguments: {} });
  const rotatedBobStatus = await bob.client.callTool({ name: "peer_status", arguments: {} });
  assert.equal(rotatedAliceStatus.structuredContent.roomId, rotatedRoomId);
  assert.equal(rotatedBobStatus.structuredContent.roomId, rotatedRoomId);
  assert.equal(rotatedAliceStatus.structuredContent.session.phase, "negotiating_goal");

  const hotAsk = alice.client.callTool({
    name: "peer_ask",
    arguments: { question: "Did hot reload require a GUI restart?", timeout_seconds: 10 },
  });
  const hotRequest = await bob.client.callTool({
    name: "peer_listen",
    arguments: { timeout_seconds: 10 },
  });
  await bob.client.callTool({
    name: "peer_respond",
    arguments: {
      request_id: hotRequest.structuredContent.request.id,
      message: "No, both existing MCP clients switched rooms in place",
    },
  });
  assert.match(textOf(await hotAsk), /switched rooms in place/);

  console.log("MCP PASS: async status collection, orphan recovery, timeout recovery, broker inbox, watcher wake, idempotency, multi-task claims, goals, and hot reload verified");
} finally {
  await Promise.allSettled([
    alice?.client.close(),
    aliceSecond?.client.close(),
    bob?.client.close(),
    bobSecond?.client.close(),
    bobWatcher?.close(),
  ]);
  relay.kill("SIGTERM");
  await new Promise((resolve) => relay.once("exit", resolve));
  if (!process.env.KEEP_AGENT_LINK_TEST_DATA) await rm(tempDir, { recursive: true, force: true });
}
