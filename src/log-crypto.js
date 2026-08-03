import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function logKey(keyMaterial) {
  return createHash("sha256")
    .update("agent-link-local-log-v1:")
    .update(keyMaterial)
    .digest();
}

export function encryptLogValue(keyMaterial, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", logKey(keyMaterial), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    $encrypted: "agent-link-log-v1",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  };
}

export function decryptLogValue(keyMaterial, value) {
  if (!value || value.$encrypted !== "agent-link-log-v1") return value;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    logKey(keyMaterial),
    Buffer.from(value.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(value.data, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8"));
}

export function decryptLogRecord(keyMaterial, value) {
  if (Array.isArray(value)) return value.map((item) => decryptLogRecord(keyMaterial, item));
  if (!value || typeof value !== "object") return value;
  if (value.$encrypted === "agent-link-log-v1") {
    return decryptLogValue(keyMaterial, value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decryptLogRecord(keyMaterial, item)]),
  );
}
