import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const lockStaleMs = 10_000;
const contendedLockErrors = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cross-process mutual exclusion for read-modify-write on a shared state file.
// Atomic replace alone prevents corruption, not lost updates.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

export async function withFileLock(filePath, task, { timeoutMs = 5_000 } = {}) {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  let handle = null;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
    } catch (error) {
      // Windows reports a contended or half-deleted lock file as EPERM/EBUSY
      // rather than EEXIST, so contention has to be recognised by more than one
      // code before this is treated as a real failure.
      if (!contendedLockErrors.has(error.code)) throw error;
      const owner = await readLockOwner(lockPath);
      // Only a dead owner may be evicted. A slow live holder keeps its lock and
      // we time out instead, because stealing it would let two writers merge
      // against the same stale snapshot.
      const reclaimable = owner
        ? !alive(owner.pid)
        : (await stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => 0)) > lockStaleMs;
      if (reclaimable) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lockPath}`);
      await pause(5);
    }
  }
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    // Never remove a lock that now belongs to someone else.
    const owner = await readLockOwner(lockPath);
    if (!owner || owner.token === token) await unlink(lockPath).catch(() => {});
  }
}

// Windows can transiently refuse to replace a file while another writer's
// rename is still in flight. The data is already on disk at that point, so the
// replace is worth retrying instead of losing the write.
const transientRenameErrors = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function writeFileAtomic(filePath, contents, { mode = 0o600, attempts = 12 } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return filePath;
    } catch (error) {
      if (!transientRenameErrors.has(error.code) || attempt >= attempts) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 5 * attempt)));
    }
  }
}
