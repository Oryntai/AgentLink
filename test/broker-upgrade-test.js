import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../src/broker-client.js";
import { brokerEndpoint } from "../src/broker-endpoint.js";
import { loadBridgeConfig } from "../src/config.js";
import { createIdentity, createRoomCode, parseRoomCode } from "../src/crypto.js";
import { decryptLogValue, encryptLogValue } from "../src/log-crypto.js";
import { requeueInFlight } from "../src/lease-state.js";
import {
  BROKER_METHODS,
  BROKER_PROTOCOL_VERSION,
  CORE_BROKER_METHODS,
  DESKTOP_BROKER_METHODS,
  MAX_CLIENT_PROTOCOL_VERSION,
  MIN_CLIENT_PROTOCOL_VERSION,
  brokerCompatibility,
} from "../src/protocol-version.js";

function startStubBroker(endpoint, handler) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const request = JSON.parse(line);
        const reply = handler(request);
        if (reply) socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    listen: () => new Promise((resolve) => server.listen(endpoint, resolve)),
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

async function writeTestConfig(configPath, agentId) {
  await writeFile(configPath, JSON.stringify({
    relayUrl: "ws://127.0.0.1:1/ws",
    roomCode: createRoomCode(),
    agentId,
    displayName: agentId,
    role: "initiator",
    identity: createIdentity(),
    logDir: "logs",
  }));
  return loadBridgeConfig(configPath);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-upgrade-test-"));
const configPath = path.join(tempDir, "active.json");
const roomCode = createRoomCode();
const identity = createIdentity();
const { roomId } = parseRoomCode(roomCode);
const runtimePath = `${configPath}.broker-runtime.json`;
const storePath = `${configPath}.${roomId}.broker.json`;

process.env.AGENT_LINK_NOTIFY = "0";
process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = "500";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

async function seedStore(entries) {
  const payload = encryptLogValue(identity.privateKey, {
    version: 2,
    messages: entries,
    outbound: {},
    completed: {},
    activity: [],
  });
  await writeFile(storePath, `${JSON.stringify({ version: 1, payload }, null, 2)}\n`, "utf8");
}

const brokerPids = new Set();

try {
  await writeFile(configPath, JSON.stringify({
    relayUrl: "ws://127.0.0.1:1/ws",
    roomCode,
    agentId: "upgrade-test",
    displayName: "Upgrade Test",
    role: "initiator",
    identity,
    logDir: "logs",
  }));

  // A handover or restart is not a failed delivery attempt: both in-flight
  // states return to the queue with the attempt budget untouched.
  const messages = [
    { requestId: "a", state: "claimed", claimedBy: "client-1", leaseUntil: "2099-01-01T00:00:00.000Z", attempts: 2 },
    { requestId: "b", state: "processing", claimedBy: "client-2", leaseUntil: "2099-01-01T00:00:00.000Z" },
    { requestId: "c", state: "queued", attempts: 1 },
    { requestId: "d", state: "responded" },
  ];
  const requeued = requeueInFlight(messages);
  assert.deepEqual(requeued.map((entry) => entry.requestId), ["a", "b"]);
  assert.equal(messages[0].state, "queued");
  assert.equal(messages[0].attempts, 2);
  assert.equal(messages[0].claimedBy, undefined);
  assert.equal(messages[0].leaseUntil, undefined);
  assert.equal(messages[1].state, "queued");
  assert.equal(messages[2].state, "queued");
  assert.equal(messages[3].state, "responded");
  assert.equal(requeueInFlight([]).length, 0);

  const current = {
    brokerProtocol: BROKER_PROTOCOL_VERSION,
    minClientProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    maxClientProtocol: MAX_CLIENT_PROTOCOL_VERSION,
    methods: [...BROKER_METHODS],
  };
  assert.equal(brokerCompatibility(current).compatible, true);
  assert.equal(brokerCompatibility(null).compatible, false);
  assert.match(brokerCompatibility(null).reason, /predates protocol negotiation/);
  assert.equal(brokerCompatibility({ brokerProtocol: 1, methods: current.methods }).compatible, false);
  const missing = brokerCompatibility({
    brokerProtocol: BROKER_PROTOCOL_VERSION,
    methods: current.methods.filter((method) => method !== "takeover"),
  });
  assert.equal(missing.compatible, false);
  assert.match(missing.reason, /missing takeover/);

  // Required methods belong to the frontend, not to the build: a broker without
  // a desktop-only method still serves a generic MCP session.
  const withoutDesktop = {
    ...current,
    methods: current.methods.filter((method) => method !== "activity_tail"),
  };
  assert.equal(
    brokerCompatibility(withoutDesktop, { requiredMethods: CORE_BROKER_METHODS }).compatible,
    true,
  );
  const desktopVerdict = brokerCompatibility(withoutDesktop, {
    requiredMethods: DESKTOP_BROKER_METHODS,
  });
  assert.equal(desktopVerdict.compatible, false);
  assert.match(desktopVerdict.reason, /missing activity_tail/);

  process.env.AGENT_LINK_MIN_BROKER_PROTOCOL = String(BROKER_PROTOCOL_VERSION + 1);
  assert.equal(brokerCompatibility(current).compatible, false);
  assert.equal(brokerCompatibility(current).required, BROKER_PROTOCOL_VERSION + 1);
  delete process.env.AGENT_LINK_MIN_BROKER_PROTOCOL;

  // A newer broker is only safe when it says which clients it still serves.
  const newerSilent = {
    brokerProtocol: BROKER_PROTOCOL_VERSION + 3,
    methods: [...BROKER_METHODS],
  };
  assert.equal(brokerCompatibility(newerSilent).compatible, false);
  assert.match(brokerCompatibility(newerSilent).reason, /does not advertise a supported client range/);
  assert.equal(brokerCompatibility({
    ...newerSilent,
    minClientProtocol: BROKER_PROTOCOL_VERSION,
    maxClientProtocol: BROKER_PROTOCOL_VERSION + 3,
  }).compatible, true);
  const dropped = brokerCompatibility({
    ...newerSilent,
    minClientProtocol: BROKER_PROTOCOL_VERSION + 1,
    maxClientProtocol: BROKER_PROTOCOL_VERSION + 3,
  });
  assert.equal(dropped.compatible, false);
  assert.match(dropped.reason, /serves client protocols \d+-\d+, not \d+/);

  // A request left mid-flight by a killed broker must not stay stuck.
  await seedStore([
    {
      requestId: "stuck-request",
      state: "processing",
      claimedBy: "gone-frontend",
      leaseUntil: "2099-01-01T00:00:00.000Z",
      attempts: 1,
      receivedAt: new Date().toISOString(),
      message: {
        id: "stuck-request",
        kind: "request",
        from: "peer",
        text: "still pending",
        metadata: { requestId: "stuck-request", displayName: "Peer" },
      },
    },
  ]);

  const config = await loadBridgeConfig(configPath);
  const first = new BrokerClient(config);
  await first.connect();

  const info = first.status().broker;
  assert.equal(info.brokerProtocol, BROKER_PROTOCOL_VERSION);
  assert.equal(info.minClientProtocol, MIN_CLIENT_PROTOCOL_VERSION);
  assert.equal(info.maxClientProtocol, MAX_CLIENT_PROTOCOL_VERSION);
  assert(BROKER_METHODS.every((method) => info.methods.includes(method)));
  assert(Number.isInteger(info.pid) && info.pid > 0);
  brokerPids.add(info.pid);

  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  assert.equal(runtime.pid, info.pid);
  assert.equal(runtime.brokerProtocol, BROKER_PROTOCOL_VERSION);
  assert.equal(runtime.draining, false);

  const inbox = await first.listInbox();
  const stuck = inbox.find((entry) => entry.requestId === "stuck-request");
  assert(stuck, "seeded request should survive broker start");
  assert.equal(stuck.state, "queued");

  const onDisk = decryptLogValue(
    identity.privateKey,
    JSON.parse(await readFile(storePath, "utf8")).payload,
  );
  assert.equal(
    onDisk.messages.find((entry) => entry.requestId === "stuck-request").state,
    "queued",
    "the recovered state must be persisted, not only held in memory",
  );

  // A frontend that needs a newer broker replaces the running one instead of
  // talking to an instance that lacks its methods.
  process.env.AGENT_LINK_MIN_BROKER_PROTOCOL = String(BROKER_PROTOCOL_VERSION + 1);
  const newer = new BrokerClient(config);
  let failure = null;
  try {
    await newer.connect();
  } catch (error) {
    failure = error;
  } finally {
    await newer.close();
    delete process.env.AGENT_LINK_MIN_BROKER_PROTOCOL;
  }

  assert(failure, "an unsatisfiable protocol requirement must fail loudly");
  assert.match(failure.message, /still incompatible after replacement/);
  assert(await waitForExit(info.pid), "the superseded broker must exit");
  await first.close();

  // Service must be restored after a handover, on a different broker process.
  const restored = new BrokerClient(config);
  await restored.connect();
  const replacement = restored.status().broker;
  brokerPids.add(replacement.pid);
  assert.notEqual(replacement.pid, info.pid);
  assert.equal(replacement.brokerProtocol, BROKER_PROTOCOL_VERSION);
  assert.equal(JSON.parse(await readFile(runtimePath, "utf8")).pid, replacement.pid);

  const restoredInbox = await restored.listInbox();
  assert.equal(
    restoredInbox.find((entry) => entry.requestId === "stuck-request")?.state,
    "queued",
    "the seeded request must survive the handover",
  );
  await restored.close();

  // A broker that predates negotiation cannot be taken over, so the frontend
  // must refuse it, leave no half-open link behind, and recover on retry.
  const legacyPath = path.join(tempDir, "legacy.json");
  const legacyBridgeConfig = await writeTestConfig(legacyPath, "legacy-test");
  const legacyStub = startStubBroker(brokerEndpoint(legacyPath), () => ({
    ok: false,
    error: "Frontend must register with the local broker",
  }));
  await legacyStub.listen();

  const legacyClient = new BrokerClient(legacyBridgeConfig);
  await assert.rejects(
    legacyClient.connect(),
    /does not support handover/,
    "a legacy broker must not be silently accepted",
  );
  assert.equal(legacyClient.status().connected, false, "a rejected link must not look connected");
  assert.equal(legacyClient.status().broker, null);

  await legacyStub.close();
  await legacyClient.connect();
  const recovered = legacyClient.status().broker;
  brokerPids.add(recovered.pid);
  assert.equal(recovered.brokerProtocol, BROKER_PROTOCOL_VERSION);
  await legacyClient.close();

  // Silence is not a verdict: a broker too busy to answer hello must surface as
  // a transport failure, never as "incompatible, stop it yourself".
  const silentPath = path.join(tempDir, "silent.json");
  const silentConfig = await writeTestConfig(silentPath, "silent-test");
  const silentStub = startStubBroker(brokerEndpoint(silentPath), () => null);
  await silentStub.listen();
  process.env.AGENT_LINK_HELLO_TIMEOUT_MS = "200";
  const silentClient = new BrokerClient(silentConfig);
  await assert.rejects(
    silentClient.connect(),
    /hello timed out/,
    "an unanswered hello must not be reported as an incompatible broker",
  );
  assert.equal(silentClient.status().connected, false);
  delete process.env.AGENT_LINK_HELLO_TIMEOUT_MS;
  await silentClient.close();
  await silentStub.close();

  // A broker without a desktop-only method still serves a generic MCP session,
  // but a desktop frontend must replace it.
  const capabilityPath = path.join(tempDir, "capability.json");
  const capabilityConfig = await writeTestConfig(capabilityPath, "capability-test");
  const capabilityEndpoint = brokerEndpoint(capabilityPath);
  const coreOnly = {
    brokerProtocol: BROKER_PROTOCOL_VERSION,
    minClientProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    maxClientProtocol: MAX_CLIENT_PROTOCOL_VERSION,
    methods: [...CORE_BROKER_METHODS],
    pid: process.pid,
    startedAt: new Date().toISOString(),
    draining: false,
    endpoint: capabilityEndpoint,
  };
  let capabilityStub = null;
  capabilityStub = startStubBroker(capabilityEndpoint, (request) => {
    if (request.method === "hello") return { ok: true, result: coreOnly };
    if (request.method === "register") return { ok: true, result: { ...coreOnly, frontendId: "stub" } };
    if (request.method === "takeover") {
      setTimeout(() => void capabilityStub.close(), 10);
      return { ok: true, result: { accepted: true, pid: process.pid, requeued: 0 } };
    }
    return { ok: false, error: `Unknown broker method: ${request.method}` };
  });
  await capabilityStub.listen();

  const mcpClient = new BrokerClient(capabilityConfig);
  await mcpClient.connect();
  assert.equal(
    mcpClient.status().broker.methods.includes("activity_tail"),
    false,
    "an MCP frontend must accept a broker that lacks desktop-only methods",
  );
  await mcpClient.close();

  const desktopClient = new BrokerClient(capabilityConfig, {
    requiredMethods: DESKTOP_BROKER_METHODS,
  });
  await desktopClient.connect();
  const desktopBroker = desktopClient.status().broker;
  brokerPids.add(desktopBroker.pid);
  assert.notEqual(desktopBroker.pid, process.pid, "the desktop frontend must replace the stub");
  assert(desktopBroker.methods.includes("activity_tail"));

  const tail = await desktopClient.activityTail(10);
  assert(
    tail.activity.some((entry) => entry.kind === "broker" && entry.state === "started"),
    "the activity ring must be readable through the broker",
  );
  assert(tail.activity.every((entry) => !("text" in entry) && !("body" in entry)));
  await desktopClient.close();

  // The operator command stops only a broker it verified over the local
  // endpoint, and it refuses to act without an explicit confirmation.
  process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = "0";
  const doomed = new BrokerClient(config);
  await doomed.connect();
  const doomedPid = doomed.status().broker.pid;
  brokerPids.add(doomedPid);
  process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = "500";

  assert.throws(
    () => execFileSync(
      process.execPath,
      [path.join(rootDir, "scripts", "stop-broker.js"), "--config", configPath],
      { encoding: "utf8", stdio: "pipe" },
    ),
    /Refusing to stop a broker without confirmation/,
    "stopping a broker must require --yes when there is no terminal",
  );
  assert(alive(doomedPid), "a refused confirmation must leave the broker running");

  const stopOutput = execFileSync(
    process.execPath,
    [path.join(rootDir, "scripts", "stop-broker.js"), "--config", configPath, "--yes"],
    { encoding: "utf8" },
  );
  assert.match(stopOutput, new RegExp(`PID:\\s+${doomedPid}`));
  assert.match(stopOutput, /answered hello on the local endpoint/);
  assert(await waitForExit(doomedPid), "stop-broker must actually stop the broker");
  await doomed.close();

  console.log("broker upgrade test passed");
} finally {
  // A failed assertion must not leak the broker the test just started.
  try {
    brokerPids.add(JSON.parse(await readFile(runtimePath, "utf8")).pid);
  } catch {
    // No broker is registered, so there is nothing left to stop.
  }
  for (const pid of brokerPids) {
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The broker already exited on its own.
      }
    }
  }
  for (const pid of brokerPids) await waitForExit(pid, 5_000);
  await rm(tempDir, { recursive: true, force: true });
}
