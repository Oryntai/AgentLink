import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRoomCode } from "../src/crypto.js";
import {
  DEFAULT_INVITE_TTL_MS,
  MAX_INVITE_TTL_MS,
  createInviteCode,
  parseInviteCode,
  roomFingerprint,
} from "../src/invite-code.js";
import { InviteRegistry } from "../src/invite-registry.js";

const relayUrl = "wss://relay.example/ws";
const roomCode = createRoomCode();
const now = Date.parse("2026-08-06T12:00:00.000Z");

const invite = createInviteCode({ relayUrl, roomCode, now });
const parsed = parseInviteCode(invite.code, { now: now + 1_000 });
assert.equal(parsed.inviteId, invite.inviteId);
assert.equal(parsed.roomCode, roomCode);
assert.equal(parsed.relayUrl, relayUrl);
assert.equal(Date.parse(parsed.expiresAt) - Date.parse(parsed.issuedAt), DEFAULT_INVITE_TTL_MS);

// An invite is a bearer credential, so it must stop working on its own.
assert.throws(
  () => parseInviteCode(invite.code, { now: now + DEFAULT_INVITE_TTL_MS + 1 }),
  /expired/,
);
assert.throws(() => createInviteCode({ relayUrl, roomCode, ttlMs: MAX_INVITE_TTL_MS + 1 }), /maximum/);
assert.throws(() => createInviteCode({ relayUrl, roomCode, ttlMs: 0 }), /positive/);

// Tampering with the payload, the checksum, or the transport must be refused.
const [prefix, payload, checksum] = invite.code.split(".");
const forgedPayload = Buffer.from(JSON.stringify({
  version: 2,
  inviteId: "forged",
  relayUrl,
  roomCode,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + DEFAULT_INVITE_TTL_MS).toISOString(),
}), "utf8").toString("base64url");
assert.throws(() => parseInviteCode(`${prefix}.${forgedPayload}.${checksum}`, { now }), /checksum/);
assert.throws(() => parseInviteCode(`${prefix}.${payload}.${checksum}.extra`, { now }), /al1 format/);
assert.throws(() => parseInviteCode("", { now }), /missing or too long/);
assert.throws(() => parseInviteCode(`al1.${"A".repeat(5_000)}.x`, { now }), /missing or too long/);
assert.throws(
  () => createInviteCode({ relayUrl: "https://relay.example", roomCode, now }),
  /ws:\/\/ or wss:\/\//,
);
assert.throws(
  () => createInviteCode({ relayUrl: "wss://user:pass@relay.example/ws", roomCode, now }),
  /cannot contain credentials/,
);

// A version 1 invite had no expiry at all, so it must not be honoured.
const legacyPayload = Buffer.from(JSON.stringify({ version: 1, relayUrl, roomCode }), "utf8")
  .toString("base64url");
const legacyChecksum = invite.code.split(".")[2];
assert.throws(
  () => parseInviteCode(`al1.${legacyPayload}.${legacyChecksum}`, { now }),
  /checksum|version is not supported/,
);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-invite-test-"));
try {
  const registryPath = path.join(tempDir, "active.json.invites.json");
  const registry = await new InviteRegistry(registryPath).load();

  const issued = await registry.issue({ relayUrl, roomCode, label: "laptop", now });
  assert.equal(registry.list({ now })[0].state, "pending");
  assert.equal(registry.list({ now })[0].roomFingerprint, roomFingerprint(roomCode));

  // The registry must be useless to whoever steals it.
  const onDisk = await readFile(registryPath, "utf8");
  assert.equal(onDisk.includes(roomCode), false, "the registry must not store the room code");
  assert.equal(onDisk.includes(issued.code), false, "the registry must not store the invite code");
  assert.equal(onDisk.includes(roomCode.split(".")[1]), false, "the room secret must never be stored");

  // Single use, bound to the public key that redeemed it.
  const guestKey = "fingerprint-guest";
  const first = registry.redeemForPeer({
    inviteId: issued.inviteId,
    agentId: "friend-claude",
    publicKeyFingerprint: guestKey,
    roomCode,
    now,
  });
  assert.equal(first.changed, true);
  await registry.save();
  assert.equal(registry.list({ now })[0].state, "consumed");
  assert.equal(registry.list({ now })[0].consumedBy.publicKeyFingerprint, guestKey);
  assert.throws(
    () => registry.redeemForPeer({
      inviteId: issued.inviteId,
      agentId: "friend-claude",
      publicKeyFingerprint: "fingerprint-thief",
      roomCode,
      now,
    }),
    /already redeemed by a different key/,
    "the same agent name with a new key must not reuse an invite",
  );
  const again = registry.redeemForPeer({
    inviteId: issued.inviteId,
    agentId: "friend-claude",
    publicKeyFingerprint: guestKey,
    roomCode,
    now,
  });
  assert.equal(again.changed, false, "the original key may retry idempotently");

  assert.throws(
    () => registry.redeemForPeer({
      inviteId: "never-issued",
      agentId: "friend-claude",
      publicKeyFingerprint: guestKey,
      roomCode,
      now,
    }),
    /not known to this room owner/,
  );
  const otherRoom = createRoomCode();
  const forOtherRoom = await registry.issue({ relayUrl, roomCode, now });
  assert.throws(
    () => registry.redeemForPeer({
      inviteId: forOtherRoom.inviteId,
      agentId: "friend-claude",
      publicKeyFingerprint: guestKey,
      roomCode: otherRoom,
      now,
    }),
    /issued for a different room/,
  );

  // Redemption must be reversible, so a failed save can refuse the peer instead
  // of leaving an invite that was consumed only in memory.
  const reversible = await registry.issue({ relayUrl, roomCode, now });
  const attempt = registry.redeemForPeer({
    inviteId: reversible.inviteId,
    agentId: "friend-claude",
    publicKeyFingerprint: guestKey,
    roomCode,
    now,
  });
  assert.equal(registry.find(reversible.inviteId).state, "consumed");
  attempt.rollback();
  assert.equal(registry.find(reversible.inviteId).state, "pending");
  assert.equal(registry.find(reversible.inviteId).consumedBy, null);

  // Revocation before use works; after use it must tell the truth instead.
  const second = await registry.issue({ relayUrl, roomCode, now });
  await registry.revoke(second.inviteId, { now });
  assert.equal(registry.find(second.inviteId).state, "revoked");
  assert.throws(
    () => registry.redeemForPeer({
      inviteId: second.inviteId,
      agentId: "friend-claude",
      publicKeyFingerprint: guestKey,
      roomCode,
      now,
    }),
    /was revoked/,
  );
  await assert.rejects(registry.revoke(issued.inviteId, { now }), /rotate the room/);
  await assert.rejects(registry.revoke("unknown-invite", { now }), /Unknown invite/);

  // An invite that expires while pending is not usable and reports as expired.
  const third = await registry.issue({ relayUrl, roomCode, ttlMs: 60_000, now });
  const afterExpiry = now + 61_000;
  assert.equal(
    registry.list({ now: afterExpiry }).find((entry) => entry.inviteId === third.inviteId).state,
    "expired",
  );
  assert.throws(
    () => registry.redeemForPeer({
      inviteId: third.inviteId,
      agentId: "friend-claude",
      publicKeyFingerprint: guestKey,
      roomCode,
      now: afterExpiry,
    }),
    /expired/,
  );
  assert.equal(
    registry.hasPending({ roomCode, now: afterExpiry }),
    true,
    "the rolled back invite is usable again",
  );
  assert.equal(
    registry.hasPending({ roomCode, now: now + MAX_INVITE_TTL_MS + 1 }),
    false,
    "nothing stays pending forever",
  );
  assert.equal(registry.hasPending({ roomCode: createRoomCode(), now }), false);

  // State survives a reload, because enforcement cannot live in memory only.
  await registry.save();
  const reloaded = await new InviteRegistry(registryPath).load();
  assert.equal(reloaded.find(issued.inviteId).state, "consumed");
  assert.equal(reloaded.find(second.inviteId).state, "revoked");
  assert.throws(
    () => reloaded.redeemForPeer({
      inviteId: issued.inviteId,
      agentId: "friend-claude",
      publicKeyFingerprint: "fingerprint-thief",
      roomCode,
      now,
    }),
    /already redeemed by a different key/,
  );

  console.log("invite security test passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
