import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

export function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function createRoomCode() {
  const roomId = `room_${toBase64Url(randomBytes(8))}`;
  const secret = toBase64Url(randomBytes(32));
  return `${roomId}.${secret}`;
}

export function parseRoomCode(roomCode) {
  const separator = roomCode.indexOf(".");
  if (separator < 1) throw new Error("Invalid room code");
  const roomId = roomCode.slice(0, separator);
  const secret = roomCode.slice(separator + 1);
  if (!/^room_[A-Za-z0-9_-]{8,}$/.test(roomId) || secret.length < 32) {
    throw new Error("Invalid room code");
  }
  return { roomId, secret };
}

export function roomAuth(roomId, secret) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`agent-link-auth:${roomId}`)
    .digest("base64url");
}

function encryptionKey(secret) {
  return createHash("sha256")
    .update(`agent-link-e2ee:${secret}`)
    .digest();
}

export function encryptPayload(roomId, secret, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(roomId, "utf8"));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: toBase64Url(iv),
    data: toBase64Url(data),
    tag: toBase64Url(cipher.getAuthTag()),
  };
}

export function decryptPayload(roomId, secret, encrypted) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(roomId, "utf8"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8"));
}

export function messageId() {
  return randomUUID();
}
