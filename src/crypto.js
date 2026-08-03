import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
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

export function identityProof(roomId, secret, agentId, publicKey) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update("agent-link-identity-v1\0")
    .update(roomId)
    .update("\0")
    .update(agentId)
    .update("\0")
    .update(publicKey)
    .digest("base64url");
}

export function verifyIdentityProof(roomId, secret, agentId, publicKey, proof) {
  if (!proof) return false;
  try {
    const expected = Buffer.from(identityProof(roomId, secret, agentId, publicKey), "base64url");
    const received = Buffer.from(proof, "base64url");
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

function encryptionKey(secret) {
  return createHash("sha256")
    .update(`agent-link-e2ee:${secret}`)
    .digest();
}

function envelopeAad(roomId, envelope = {}) {
  return Buffer.from(JSON.stringify({
    version: envelope.version || 1,
    roomId,
    id: envelope.id || null,
    from: envelope.from || null,
    to: envelope.to || null,
    sentAt: envelope.sentAt || null,
  }), "utf8");
}

export function encryptPayload(roomId, secret, payload, envelope = {}) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(envelopeAad(roomId, envelope));
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

export function decryptPayload(roomId, secret, encrypted, envelope = {}) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAAD(envelopeAad(roomId, envelope));
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

export function createIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function canonicalEnvelope(envelope) {
  return Buffer.from(JSON.stringify({
    version: envelope.version,
    id: envelope.id,
    roomId: envelope.roomId,
    from: envelope.from,
    to: envelope.to || null,
    sentAt: envelope.sentAt,
    encrypted: {
      iv: envelope.encrypted?.iv,
      data: envelope.encrypted?.data,
      tag: envelope.encrypted?.tag,
    },
  }), "utf8");
}

export function signEnvelope(privateKey, envelope) {
  return sign(null, canonicalEnvelope(envelope), privateKey).toString("base64url");
}

export function verifyEnvelope(publicKey, envelope) {
  if (!envelope.signature) return false;
  return verify(
    null,
    canonicalEnvelope(envelope),
    publicKey,
    Buffer.from(envelope.signature, "base64url"),
  );
}
