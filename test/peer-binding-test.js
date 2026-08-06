import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../src/bridge-client.js";
import {
  createIdentity,
  createRoomCode,
  parseRoomCode,
  publicKeyFingerprint,
} from "../src/crypto.js";
import { InviteRegistry } from "../src/invite-registry.js";

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

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-binding-test-"));
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
// Mallory holds the room code — the exact situation a leaked invite creates —
// but is a different identity than the peer that already joined.
const malloryConfig = {
  ...base,
  configPath: path.join(tempDir, "mallory.json"),
  agentId: "mallory-agent",
  displayName: "Mallory",
  role: "responder",
  identity: createIdentity(),
};

const dataFile = path.join(tempDir, "relay-state.json");

async function startRelay() {
  const child = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
    cwd: rootDir,
    env: {
      ...process.env,
      AGENT_LINK_HOST: "127.0.0.1",
      AGENT_LINK_PORT: String(port),
      AGENT_LINK_DATA_FILE: dataFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForRelay(child);
  return child;
}

let relay = await startRelay();
async function resetRelay() {
  relay.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(dataFile, { force: true });
  relay = await startRelay();
}

let alice;
let bob;
let mallory;
let aliceAgain;
const opened = [];
try {
  alice = new BridgeClient(aliceConfig);
  await alice.connect();
  bob = new BridgeClient(bobConfig);
  await bob.connect();

  assert(await waitFor(() => alice.boundPeer), "the first peer must be bound on contact");
  assert.equal(alice.boundPeer.agentId, "bob-claude");
  assert.equal(alice.boundPeer.roomId, roomId);
  assert(await waitFor(() => bob.boundPeer), "binding is symmetric");
  assert.equal(bob.boundPeer.agentId, "alice-codex");

  const trust = JSON.parse(await readFile(`${aliceConfig.configPath}.${roomId}.trust.json`, "utf8"));
  assert.equal(trust.boundPeer.agentId, "bob-claude");
  assert.equal(trust.boundPeer.roomId, roomId);

  await alice.close();
  await bob.close();

  // The relay caps a room at two agent ids, but that state is the relay's, not
  // the owner's: an ephemeral or hostile relay can forget it. Simulate exactly
  // that, so the only thing standing between a leaked room code and a new peer
  // is the local binding.
  await resetRelay();

  mallory = new BridgeClient(malloryConfig);
  await mallory.connect();

  aliceAgain = new BridgeClient(aliceConfig);
  await assert.rejects(
    aliceAgain.connect(),
    /Room is bound to bob-claude/,
    "knowing the room code must not admit a second identity",
  );

  // Rotating the room is the documented way to admit a different peer.
  const rotated = createRoomCode();
  const rotatedRoom = parseRoomCode(rotated);
  const aliceRotated = new BridgeClient({
    ...aliceConfig,
    roomCode: rotated,
    roomId: rotatedRoom.roomId,
    secret: rotatedRoom.secret,
  });
  opened.push(aliceRotated);
  await aliceRotated.connect();
  assert.equal(aliceRotated.boundPeer, null, "a rotated room starts unbound");

  // The same peer name with a NEW key is exactly what rotation is for, so the
  // old room's binding must not follow the owner into the new room.
  const rebornBob = new BridgeClient({
    ...bobConfig,
    roomCode: rotated,
    roomId: rotatedRoom.roomId,
    secret: rotatedRoom.secret,
    identity: createIdentity(),
  });
  opened.push(rebornBob);
  await rebornBob.connect();
  assert(
    await waitFor(() => aliceRotated.boundPeer),
    "a rotated room must admit the same agent id under a new key",
  );
  assert.equal(aliceRotated.boundPeer.agentId, "bob-claude");
  const oldTrust = JSON.parse(
    await readFile(`${aliceConfig.configPath}.${roomId}.trust.json`, "utf8"),
  );
  assert.equal(oldTrust.boundPeer.roomId, roomId, "the previous room's binding stays intact");
  assert.notEqual(
    JSON.parse(await readFile(`${aliceConfig.configPath}.${rotatedRoom.roomId}.trust.json`, "utf8"))
      .boundPeer.publicKey,
    oldTrust.boundPeer.publicKey,
  );
  await rebornBob.close();
  await aliceRotated.close();

  // The issuer redeems the invite during the peer handshake, against the peer
  // public key, before it pins anything.
  await resetRelay();
  const inviteRoom = createRoomCode();
  const inviteRoomIds = parseRoomCode(inviteRoom);
  const issuerConfig = {
    ...base,
    roomCode: inviteRoom,
    roomId: inviteRoomIds.roomId,
    secret: inviteRoomIds.secret,
    configPath: path.join(tempDir, "issuer.json"),
    agentId: "issuer-codex",
    displayName: "Issuer",
    role: "initiator",
    identity: createIdentity(),
    requireInvite: true,
  };
  const registryPath = `${issuerConfig.configPath}.invites.json`;
  const registry = await new InviteRegistry(registryPath).load();
  const issued = await registry.issue({ relayUrl: base.relayUrl, roomCode: inviteRoom });

  const guestIdentity = createIdentity();
  const guestConfig = {
    ...issuerConfig,
    configPath: path.join(tempDir, "guest.json"),
    agentId: "guest-claude",
    displayName: "Guest",
    role: "responder",
    identity: guestIdentity,
    requireInvite: false,
    inviteId: issued.inviteId,
  };

  const issuer = new BridgeClient(issuerConfig);
  opened.push(issuer);
  await issuer.connect();
  const guest = new BridgeClient(guestConfig);
  opened.push(guest);
  await guest.connect();
  assert(await waitFor(() => issuer.boundPeer), "the invited peer must be admitted");

  const guestFingerprint = publicKeyFingerprint(guestIdentity.publicKey);
  let consumed = null;
  assert(
    await waitFor(async () => {
      consumed = (await new InviteRegistry(registryPath).load()).find(issued.inviteId);
      return consumed?.state === "consumed";
    }),
    "redemption must be persisted by the issuer",
  );
  assert.equal(consumed.consumedBy.agentId, "guest-claude");
  assert.equal(
    consumed.consumedBy.publicKeyFingerprint,
    guestFingerprint,
    "the invite binds to the peer key, not to its name",
  );

  assert.equal(issuer.status().peer.verification, "pending");
  assert.equal(issuer.status().peer.fingerprint, guestFingerprint);
  await assert.rejects(issuer.markPeerVerified("wrong-fingerprint"), /does not match/);
  assert.equal((await issuer.markPeerVerified(guestFingerprint)).verification, "verified");

  // Two processes sharing one config must not lose a trust write to a shared
  // temporary file.
  const twin = new BridgeClient(issuerConfig);
  opened.push(twin);
  await twin.trustReady;
  assert(twin.boundPeer, "the twin must load the binding from disk");
  // Each side knows message ids the other has never seen: a concurrent save must
  // merge them, not overwrite them.
  for (let index = 0; index < 20; index += 1) {
    issuer.seen.add(`issuer-${index}`);
    twin.seen.add(`twin-${index}`);
  }
  await Promise.all(Array.from({ length: 15 }, () => [
    issuer.markPeerVerified(),
    twin.markPeerVerified(),
  ]).flat());
  const trustAfterRace = JSON.parse(
    await readFile(`${issuerConfig.configPath}.${inviteRoomIds.roomId}.trust.json`, "utf8"),
  );
  assert.equal(trustAfterRace.boundPeer.agentId, "guest-claude");
  assert.equal(trustAfterRace.boundPeer.verification, "verified");
  assert.equal(trustAfterRace.peers["guest-claude"], guestIdentity.publicKey);
  const persistedSeen = new Set(trustAfterRace.seenMessageIds);
  for (let index = 0; index < 20; index += 1) {
    assert(persistedSeen.has(`issuer-${index}`), `issuer-${index} must survive the race`);
    assert(persistedSeen.has(`twin-${index}`), `twin-${index} must survive the race`);
  }

  await issuer.close();
  await guest.close();

  // If the redemption cannot be recorded, the peer must not be admitted at all:
  // an invite consumed only in memory would be reusable after a crash.
  await resetRelay();
  const brittleInvite = await new InviteRegistry(registryPath).load()
    .then((loaded) => loaded.issue({ relayUrl: base.relayUrl, roomCode: inviteRoom }));
  const brittleRegistry = await new InviteRegistry(registryPath).load();
  brittleRegistry.save = async () => {
    throw new Error("disk is full");
  };
  const brittleGuest = new BridgeClient({
    ...guestConfig,
    configPath: path.join(tempDir, "brittle-guest.json"),
    agentId: "brittle-guest",
    identity: createIdentity(),
    inviteId: brittleInvite.inviteId,
  });
  opened.push(brittleGuest);
  await brittleGuest.connect();
  const brittleIssuer = new BridgeClient(
    { ...issuerConfig, configPath: path.join(tempDir, "brittle-issuer.json") },
    { inviteRegistry: brittleRegistry },
  );
  opened.push(brittleIssuer);
  await assert.rejects(
    brittleIssuer.connect(),
    /Could not record invite redemption/,
    "a redemption that cannot be persisted must refuse the peer",
  );
  assert.equal(brittleIssuer.boundPeer, null, "a refused peer must not be pinned");
  assert.equal(
    (await new InviteRegistry(registryPath).load()).find(brittleInvite.inviteId).state,
    "pending",
    "the invite must stay usable after a failed redemption",
  );
  await brittleGuest.close();

  // A stolen invite replayed by a different key is refused even after the relay
  // forgets which agents were ever in the room.
  await resetRelay();
  const thief = new BridgeClient({
    ...guestConfig,
    configPath: path.join(tempDir, "thief.json"),
    agentId: "thief-agent",
    displayName: "Thief",
    identity: createIdentity(),
    inviteId: issued.inviteId,
  });
  opened.push(thief);
  await thief.connect();

  // An already bound room refuses before touching the invite, so a peer we were
  // going to reject cannot burn someone else's invite on the way out.
  const issuerAgain = new BridgeClient(issuerConfig);
  opened.push(issuerAgain);
  await assert.rejects(
    issuerAgain.connect(),
    /Room is bound to guest-claude/,
    "the binding is checked before the invite is consumed",
  );

  // A fresh owner install with the same registry has no binding to hide behind,
  // so the refusal has to come from the invite itself.
  const issuerFresh = new BridgeClient(
    { ...issuerConfig, configPath: path.join(tempDir, "issuer-fresh.json") },
    { inviteRegistry: await new InviteRegistry(registryPath).load() },
  );
  opened.push(issuerFresh);
  await assert.rejects(
    issuerFresh.connect(),
    /already redeemed by a different key/,
    "a replayed invite must not admit a second key",
  );
  await thief.close();

  // With invites required, a peer that presents none is refused outright.
  await resetRelay();
  const uninvited = new BridgeClient({
    ...guestConfig,
    configPath: path.join(tempDir, "uninvited.json"),
    agentId: "uninvited-agent",
    displayName: "Uninvited",
    identity: createIdentity(),
    inviteId: undefined,
  });
  opened.push(uninvited);
  await uninvited.connect();
  const issuerStrict = new BridgeClient({
    ...issuerConfig,
    configPath: path.join(tempDir, "issuer-strict.json"),
  });
  opened.push(issuerStrict);
  await assert.rejects(issuerStrict.connect(), /presented no invite/);

  console.log("peer binding test passed");
} finally {
  await Promise.allSettled([
    alice?.close(),
    bob?.close(),
    mallory?.close(),
    aliceAgain?.close(),
    ...opened.map((client) => client?.close()),
  ]);
  relay.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(tempDir, { recursive: true, force: true });
}
