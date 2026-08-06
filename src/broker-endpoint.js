import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function brokerEndpoint(configPath) {
  const normalized = process.platform === "win32"
    ? path.resolve(configPath).toLowerCase()
    : path.resolve(configPath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\agent-link-${id}`
    : path.join(os.tmpdir(), `agent-link-${id}.sock`);
}
