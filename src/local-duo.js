import { readFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "./atomic-file.js";

export const LOCAL_DUO_FILE = "local-duo.json";

export function localDuoPath(configDir) {
  return path.join(configDir, LOCAL_DUO_FILE);
}

function validateProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("Local Duo profile is invalid");
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(profile.id || "")) {
    throw new Error("Local Duo profile id is invalid");
  }
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(profile.agentId || "")) {
    throw new Error("Local Duo agent id is invalid");
  }
  if (!profile.configPath || !path.isAbsolute(profile.configPath)) {
    throw new Error("Local Duo profile config path is invalid");
  }
  if (!profile.workspace || !path.isAbsolute(profile.workspace)) {
    throw new Error("Local Duo profile workspace is invalid");
  }
  if (!["initiator", "responder"].includes(profile.role)) {
    throw new Error("Local Duo profile role is invalid");
  }
  return {
    id: profile.id,
    agentId: profile.agentId,
    displayName: String(profile.displayName || profile.agentId).slice(0, 64),
    role: profile.role,
    workspace: profile.workspace,
    configPath: profile.configPath,
    claim: profile.claim && typeof profile.claim === "object" ? {
      pid: Number(profile.claim.pid),
      claimedAt: profile.claim.claimedAt || null,
    } : null,
  };
}

function validateLocalDuo(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length !== 2) {
    throw new Error("Local Duo setup must contain exactly two profiles");
  }
  const profiles = value.profiles.map(validateProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== 2) {
    throw new Error("Local Duo profile ids must be unique");
  }
  if (new Set(profiles.map((profile) => profile.agentId)).size !== 2) {
    throw new Error("Local Duo agent ids must be unique");
  }
  let relayUrl;
  try {
    relayUrl = new URL(value.relayUrl);
  } catch {
    throw new Error("Local Duo relay URL is invalid");
  }
  if (relayUrl.protocol !== "ws:" || relayUrl.hostname !== "127.0.0.1" || relayUrl.pathname !== "/ws") {
    throw new Error("Local Duo relay must be a local ws://127.0.0.1 relay");
  }
  return {
    version: 1,
    roomName: String(value.roomName || "Local Duo").slice(0, 64),
    relayUrl: relayUrl.toString(),
    createdAt: value.createdAt || null,
    profiles,
  };
}

export async function loadLocalDuo(configDir) {
  const filePath = localDuoPath(configDir);
  try {
    return validateLocalDuo(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveLocalDuo(configDir, duo) {
  const filePath = localDuoPath(configDir);
  const normalized = validateLocalDuo(duo);
  await withFileLock(filePath, () => writeFileAtomic(
    filePath,
    `${JSON.stringify(normalized, null, 2)}\n`,
  ));
  return normalized;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function claimLocalDuoProfile(configDir, profileId, { pid = process.pid } = {}) {
  const filePath = localDuoPath(configDir);
  return withFileLock(filePath, async () => {
    const duo = await loadLocalDuo(configDir);
    if (!duo) throw new Error("Local Duo is not configured by this owner");
    const profile = duo.profiles.find((entry) => entry.id === profileId);
    if (!profile) throw new Error(`Unknown Local Duo profile: ${profileId}`);
    if (profile.claim?.pid !== pid && processIsAlive(profile.claim?.pid)) {
      throw new Error(`Local Duo profile ${profileId} is already claimed by another active agent`);
    }
    profile.claim = { pid, claimedAt: new Date().toISOString() };
    await writeFileAtomic(filePath, `${JSON.stringify(duo, null, 2)}\n`);
    return profile;
  });
}

export async function releaseLocalDuoProfile(configDir, profileId, { pid = process.pid } = {}) {
  const filePath = localDuoPath(configDir);
  return withFileLock(filePath, async () => {
    const duo = await loadLocalDuo(configDir);
    const profile = duo?.profiles.find((entry) => entry.id === profileId);
    if (!profile || profile.claim?.pid !== pid) return false;
    profile.claim = null;
    await writeFileAtomic(filePath, `${JSON.stringify(duo, null, 2)}\n`);
    return true;
  });
}
