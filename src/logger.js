import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { encryptLogValue } from "./log-crypto.js";

function redactString(value) {
  return value
    .replace(/room_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{32,}/g, "[REDACTED_ROOM_CODE]")
    .replace(/\b(?:sk-ant|sk-proj|sk-)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]");
}

function redact(value, sensitiveKey, keyName = "") {
  if (sensitiveKey && /^(text|message|goal|summary|question|note|successCriteria|finishSummary)$/i.test(keyName)) {
    return encryptLogValue(sensitiveKey, value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, sensitiveKey, keyName));
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /secret|roomCode|token|auth|privateKey/i.test(key)
      ? "[REDACTED]"
      : redact(item, sensitiveKey, key);
  }
  return result;
}

export class JsonlLogger {
  constructor(filePath, base = {}, options = {}) {
    this.filePath = filePath;
    this.base = base;
    this.sensitiveKey = options.sensitiveKey || null;
    this.maxBytes = Number(process.env.AGENT_LINK_LOG_MAX_BYTES || 5 * 1024 * 1024);
    this.maxFiles = Number(process.env.AGENT_LINK_LOG_MAX_FILES || 3);
    this.size = 0;
    this.ready = mkdir(path.dirname(filePath), { recursive: true }).then(async () => {
      try {
        this.size = (await stat(filePath)).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    });
    this.chain = Promise.resolve();
  }

  write(event, details = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      ...this.base,
      event,
      ...redact(details, this.sensitiveKey),
    };
    const line = `${JSON.stringify(record)}\n`;
    this.chain = this.chain.then(async () => {
      await this.ready;
      const bytes = Buffer.byteLength(line);
      if (this.maxBytes > 0 && this.size + bytes > this.maxBytes) await this.#rotate();
      await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
      this.size += bytes;
    });
    return this.chain;
  }

  flush() {
    return this.chain;
  }

  async #rotate() {
    if (this.maxFiles < 1) {
      await rm(this.filePath, { force: true });
      this.size = 0;
      return;
    }
    await rm(`${this.filePath}.${this.maxFiles}`, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      try {
        await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    try {
      await rename(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.size = 0;
  }
}
