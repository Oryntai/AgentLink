import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../src/atomic-file.js";
import { mergeTrust, sanitizeTrust } from "../src/trust-store.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-atomic-test-"));

try {
  const target = path.join(tempDir, "nested", "state.json");
  await writeFileAtomic(target, "first\n");
  assert.equal(await readFile(target, "utf8"), "first\n");
  await writeFileAtomic(target, "second\n");
  assert.equal(await readFile(target, "utf8"), "second\n");

  // Concurrent holders must not overlap, or a read-modify-write loses updates.
  const order = [];
  let inside = 0;
  await Promise.all(Array.from({ length: 8 }, (_, index) => withFileLock(target, async () => {
    inside += 1;
    assert.equal(inside, 1, "only one holder at a time");
    order.push(index);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inside -= 1;
  })));
  assert.equal(order.length, 8);

  // A lock left behind by a process that no longer exists is reclaimable.
  const corpse = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = await new Promise((resolve) => corpse.once("exit", () => resolve(corpse.pid)));
  await writeFile(`${target}.lock`, JSON.stringify({ pid: deadPid, token: "stale" }), "utf8");
  const reclaimed = await withFileLock(target, async () => "reclaimed", { timeoutMs: 2_000 });
  assert.equal(reclaimed, "reclaimed", "a dead owner's lock must be reclaimed");

  // A live owner's lock must never be stolen, however old it looks.
  await writeFile(`${target}.lock`, JSON.stringify({ pid: process.pid, token: "held" }), "utf8");
  await assert.rejects(
    withFileLock(target, async () => "stolen", { timeoutMs: 300 }),
    /Timed out waiting for/,
    "a live holder keeps its lock",
  );
  assert.equal(
    JSON.parse(await readFile(`${target}.lock`, "utf8")).token,
    "held",
    "a failed acquisition must leave the owner's lock alone",
  );
  await rm(`${target}.lock`, { force: true });

  // Trust merges are monotonic and room scoped.
  const roomId = "room_abc";
  const disk = {
    peers: { bob: "key-bob" },
    boundPeer: { roomId, agentId: "bob", publicKey: "key-bob", verification: "pending" },
    seenMessageIds: ["a", "b"],
  };
  const local = {
    peers: { bob: "key-bob", carol: "key-carol" },
    boundPeer: {
      roomId,
      agentId: "bob",
      publicKey: "key-bob",
      verification: "verified",
      verifiedAt: "2026-08-06T00:00:00.000Z",
    },
    seenMessageIds: ["b", "c"],
  };
  const merged = mergeTrust(disk, local, { roomId });
  assert.deepEqual(merged.seenMessageIds.sort(), ["a", "b", "c"]);
  assert.equal(merged.peers.carol, "key-carol");
  assert.equal(merged.boundPeer.verification, "verified", "a completed verification wins");

  const conflicting = mergeTrust(disk, { ...local, peers: { bob: "key-impostor" } }, { roomId });
  assert.equal(conflicting.peers.bob, "key-bob", "the first recorded key wins a conflict");

  const otherRoom = mergeTrust(
    { ...disk, boundPeer: { ...disk.boundPeer, roomId: "room_other" } },
    { peers: {}, boundPeer: null, seenMessageIds: [] },
    { roomId },
  );
  assert.equal(otherRoom.boundPeer, null, "a binding from another room is stale data");

  const sanitized = sanitizeTrust({
    peers: { bob: "key-bob", "": "ignored" },
    boundPeer: { roomId, agentId: "bob", publicKey: "key-bob", secret: "leak", verification: "yes" },
    seenMessageIds: ["ok", null],
  });
  assert.deepEqual(Object.keys(sanitized.peers), ["bob"]);
  assert.equal(sanitized.boundPeer.verification, "pending");
  assert.equal("secret" in sanitized.boundPeer, false, "unknown fields must not survive");
  assert.deepEqual(sanitized.seenMessageIds, ["ok"]);

  console.log("atomic file test passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
