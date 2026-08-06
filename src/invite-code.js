import { createHash, randomUUID } from "node:crypto";
import { parseRoomCode } from "./crypto.js";

const prefix = "al1";
const maxInviteLength = 4_096;
const inviteVersion = 2;

export const DEFAULT_INVITE_TTL_MS = 15 * 60 * 1_000;
export const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1_000;

function checksum(payload) {
  return createHash("sha256").update(`agent-link-invite-v1:${payload}`).digest("base64url").slice(0, 10);
}

export function roomFingerprint(roomCode) {
  return createHash("sha256").update(`agent-link-room:${roomCode}`).digest("base64url").slice(0, 16);
}

function normalizeRelayUrl(value) {
  let relayUrl;
  try {
    relayUrl = new URL(value);
  } catch {
    throw new Error("Invite relay URL is invalid");
  }
  if (!["ws:", "wss:"].includes(relayUrl.protocol)) {
    throw new Error("Invite relay URL must use ws:// or wss://");
  }
  if (relayUrl.username || relayUrl.password) {
    throw new Error("Invite relay URL cannot contain credentials");
  }
  return relayUrl.toString();
}

export function createInviteCode({
  relayUrl,
  roomCode,
  ttlMs = DEFAULT_INVITE_TTL_MS,
  label = null,
  now = Date.now(),
}) {
  parseRoomCode(roomCode);
  const lifetime = Number(ttlMs);
  if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error("Invite ttlMs must be positive");
  if (lifetime > MAX_INVITE_TTL_MS) throw new Error("Invite ttlMs exceeds the 24 hour maximum");
  const inviteId = randomUUID();
  const payload = Buffer.from(JSON.stringify({
    version: inviteVersion,
    inviteId,
    relayUrl: normalizeRelayUrl(relayUrl),
    roomCode,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetime).toISOString(),
    label: label ? String(label).slice(0, 64) : null,
  }), "utf8").toString("base64url");
  return {
    inviteId,
    code: `${prefix}.${payload}.${checksum(payload)}`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetime).toISOString(),
    roomFingerprint: roomFingerprint(roomCode),
    label: label ? String(label).slice(0, 64) : null,
  };
}

export function parseInviteCode(value, { now = Date.now() } = {}) {
  const invite = String(value || "").trim();
  if (!invite || invite.length > maxInviteLength) throw new Error("Invite code is missing or too long");
  const [actualPrefix, payload, actualChecksum, extra] = invite.split(".");
  if (actualPrefix !== prefix || !payload || !actualChecksum || extra) {
    throw new Error("Invite code must use the al1 format");
  }
  if (checksum(payload) !== actualChecksum) throw new Error("Invite code checksum is invalid");
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invite code payload is invalid");
  }
  if (decoded.version !== inviteVersion) {
    throw new Error("Invite code version is not supported; ask for a new invite");
  }
  if (!decoded.inviteId) throw new Error("Invite code is missing its identifier");
  const expiresAt = Date.parse(decoded.expiresAt);
  const issuedAt = Date.parse(decoded.issuedAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt)) {
    throw new Error("Invite code has no usable validity window");
  }
  if (expiresAt - issuedAt > MAX_INVITE_TTL_MS) {
    throw new Error("Invite code lifetime exceeds the 24 hour maximum");
  }
  if (expiresAt <= now) throw new Error(`Invite code expired at ${decoded.expiresAt}`);
  parseRoomCode(decoded.roomCode);
  return {
    inviteId: decoded.inviteId,
    relayUrl: normalizeRelayUrl(decoded.relayUrl),
    roomCode: decoded.roomCode,
    issuedAt: decoded.issuedAt,
    expiresAt: decoded.expiresAt,
    label: decoded.label || null,
    roomFingerprint: roomFingerprint(decoded.roomCode),
  };
}
