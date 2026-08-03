import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /secret|roomCode|token|auth/i.test(key) ? "[REDACTED]" : redact(item);
  }
  return result;
}

export class JsonlLogger {
  constructor(filePath, base = {}) {
    this.filePath = filePath;
    this.base = base;
    this.ready = mkdir(path.dirname(filePath), { recursive: true });
    this.chain = Promise.resolve();
  }

  write(event, details = {}) {
    const record = {
      timestamp: new Date().toISOString(),
      ...this.base,
      event,
      ...redact(details),
    };
    this.chain = this.chain.then(async () => {
      await this.ready;
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    });
    return this.chain;
  }

  flush() {
    return this.chain;
  }
}
