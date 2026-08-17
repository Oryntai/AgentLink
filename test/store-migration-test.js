import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { createIdentity, createRoomCode, parseRoomCode } from "../src/crypto.js";
import { decryptLogValue, encryptLogValue } from "../src/log-crypto.js";
import {
  DEFAULT_ACTIVITY_LIMIT,
  STORE_VERSION,
  activityLimit,
  activityRecord,
  migrateStore,
  recordActivity,
  recordTranscript,
  transcriptRecord,
} from "../src/store-migration.js";

const activityKeys = ["ts", "kind", "messageKind", "requestId", "peer", "state", "reason"];

// A version 1 store predates the activity ring entirely.
const legacyStore = {
  version: 1,
  messages: [{ requestId: "old", state: "queued", message: { id: "old", kind: "request" } }],
  outbound: { out: { requestId: "out", state: "queued" } },
  completed: { done: { completedAt: new Date().toISOString() } },
  transcript: [{
    id: "message:legacy",
    messageId: "legacy",
    direction: "outbound",
    kind: "chat",
    author: "Legacy",
    text: "encrypted transcript body",
    state: "sent",
    createdAt: "2026-08-06T10:00:00.000Z",
  }],
};

const migrated = migrateStore(structuredClone(legacyStore));
assert.equal(migrated.version, STORE_VERSION);
assert.deepEqual(migrated.messages, legacyStore.messages);
assert.deepEqual(migrated.outbound, legacyStore.outbound);
assert.deepEqual(migrated.completed, legacyStore.completed);
assert.equal(migrated.transcript.length, 1);
assert.equal(migrated.transcript[0].text, "encrypted transcript body");
assert.deepEqual(migrated.activity, []);

const repaired = migrateStore({ messages: "nonsense", outbound: null, activity: 7 });
assert.deepEqual(repaired.messages, []);
assert.deepEqual(repaired.outbound, {});
assert.deepEqual(repaired.completed, {});
assert.deepEqual(repaired.transcript, []);
assert.deepEqual(repaired.activity, []);
assert.equal(migrateStore(null).version, STORE_VERSION);

// The ring is metadata only: anything carrying content is dropped on the way in.
const smuggled = migrateStore({
  activity: [
    {
      kind: "inbound",
      requestId: "r1",
      state: "queued",
      text: "secret request body",
      body: "secret",
      roomCode: "room_abc.secret",
    },
  ],
});
assert.equal(smuggled.activity.length, 1);
assert.deepEqual(Object.keys(smuggled.activity[0]).sort(), [...activityKeys].sort());
assert.equal(JSON.stringify(smuggled.activity).includes("secret"), false);

assert.equal(activityRecord({}), null, "an event without a kind is not an event");
const truncated = activityRecord({ kind: "x".repeat(80), reason: "y".repeat(300) });
assert.equal(truncated.kind.length, 40);
assert.equal(truncated.reason.length, 120);
assert.equal(truncated.requestId, null);

// A timestamp is rebuilt too, so a seeded value cannot grow the ring entry.
assert.equal(activityRecord({ kind: "inbound", ts: "9".repeat(500) }).ts.length, 24);
assert.equal(activityRecord({ kind: "inbound", ts: "not a date" }).ts.length, 24);
assert.equal(
  activityRecord({ kind: "inbound", ts: "2026-08-06T10:00:00.000Z" }).ts,
  "2026-08-06T10:00:00.000Z",
);
assert(Date.parse(activityRecord({ kind: "inbound" }).ts) > 0);

// A malformed bound must fall back, never disable trimming.
assert.equal(activityLimit(undefined), DEFAULT_ACTIVITY_LIMIT);
assert.equal(activityLimit("not a number"), DEFAULT_ACTIVITY_LIMIT);
assert.equal(activityLimit(Number.POSITIVE_INFINITY), DEFAULT_ACTIVITY_LIMIT);
assert.equal(activityLimit(-5), DEFAULT_ACTIVITY_LIMIT);
assert.equal(activityLimit(0), DEFAULT_ACTIVITY_LIMIT);
assert.equal(activityLimit(3), 10, "a tiny bound is raised to the floor");
assert.equal(activityLimit(1e9), 10_000, "a huge bound is capped");
assert.equal(activityLimit("250"), 250);

const ring = { activity: [] };
for (let index = 0; index < 25; index += 1) {
  recordActivity(ring, { kind: "inbound", requestId: `r${index}` }, 10);
}
assert.equal(ring.activity.length, 10, "the ring must stay bounded");
assert.equal(ring.activity[0].requestId, "r15");
assert.equal(ring.activity.at(-1).requestId, "r24");
assert.equal(recordActivity(ring, { requestId: "no-kind" }, 10), null);
assert.equal(ring.activity.length, 10);

const transcript = {};
assert.equal(transcriptRecord({ id: "missing-text", direction: "outbound" }), null);
recordTranscript(transcript, {
  id: "request:1",
  messageId: "envelope-1",
  requestId: "1",
  direction: "outbound",
  kind: "request",
  author: "Alice",
  text: "inspect the release branch",
  state: "sent",
  createdAt: "2026-08-06T10:00:00.000Z",
});
recordTranscript(transcript, {
  id: "request:1",
  state: "read",
  updatedAt: "2026-08-06T10:01:00.000Z",
});
assert.equal(transcript.transcript.length, 1, "a receipt updates its existing bubble");
assert.equal(transcript.transcript[0].text, "inspect the release branch");
assert.equal(transcript.transcript[0].state, "read");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-store-test-"));
const configPath = path.join(tempDir, "active.json");
const roomCode = createRoomCode();
const identity = createIdentity();
const { roomId } = parseRoomCode(roomCode);
const storePath = `${configPath}.${roomId}.broker.json`;

process.env.AGENT_LINK_NOTIFY = "0";
process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = "500";
process.env.AGENT_LINK_MAX_ACTIVITY_ENTRIES = "3";

let brokerPid = null;
try {
  await writeFile(configPath, JSON.stringify({
    relayUrl: "ws://127.0.0.1:1/ws",
    roomCode,
    agentId: "store-test",
    displayName: "Store Test",
    role: "initiator",
    identity,
    logDir: "logs",
  }));

  const oversized = Array.from({ length: 40 }, (_, index) => ({
    ts: new Date().toISOString(),
    kind: "inbound",
    requestId: `seed-${index}`,
    state: "queued",
    text: "must not survive",
  }));
  await writeFile(storePath, `${JSON.stringify({
    version: 1,
    payload: encryptLogValue(identity.privateKey, { ...legacyStore, activity: oversized }),
  }, null, 2)}\n`, "utf8");

  const client = new BrokerClient(await loadBridgeConfig(configPath));
  await client.connect();
  brokerPid = client.status().broker.pid;
  await client.remoteStatus();

  const encryptedStore = await readFile(storePath, "utf8");
  const onDisk = decryptLogValue(
    identity.privateKey,
    JSON.parse(encryptedStore).payload,
  );
  assert.equal(onDisk.version, STORE_VERSION, "the broker must persist the migrated version");
  assert(
    onDisk.activity.length <= 10,
    "the persisted ring must honour the clamped bound, not the raw environment value",
  );
  assert(
    onDisk.activity.some((entry) => entry.kind === "broker" && entry.state === "started"),
    "broker start must be recorded",
  );
  assert.equal(JSON.stringify(onDisk.activity).includes("must not survive"), false);
  assert.equal(onDisk.transcript[0].text, "encrypted transcript body");
  assert.equal(encryptedStore.includes("encrypted transcript body"), false);
  for (const entry of onDisk.activity) {
    assert.deepEqual(Object.keys(entry).sort(), [...activityKeys].sort());
  }
  assert.equal(onDisk.messages[0].requestId, "old", "migration must not drop queued requests");

  await client.close();
  console.log("store migration test passed");
} finally {
  delete process.env.AGENT_LINK_MAX_ACTIVITY_ENTRIES;
  if (brokerPid) {
    try {
      process.kill(brokerPid, "SIGTERM");
    } catch {
      // The broker already exited on its own.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(tempDir, { recursive: true, force: true });
}
