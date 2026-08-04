import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomCode } from "../src/crypto.js";
import { writeParticipantConfig } from "../scripts/setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-install-test-"));
const codexHome = path.join(tempDir, "codex-home");

try {
  const { activeConfigPath } = await writeParticipantConfig({
    configDir: path.join(tempDir, "agent-link"),
    relayUrl: "ws://127.0.0.1:8787/ws",
    roomCode: createRoomCode(),
    agentId: "install-test-agent",
    displayName: "Install Test Agent",
    role: "initiator",
  });
  const args = [
    path.join(rootDir, "scripts", "install-mcp.js"),
    "--config",
    activeConfigPath,
    "--client",
    "codex",
  ];
  const env = { ...process.env, CODEX_HOME: codexHome };
  const first = execFileSync(process.execPath, args, { cwd: rootDir, env, encoding: "utf8" });
  assert.match(first, /Restart Codex Desktop once/);
  const second = execFileSync(process.execPath, args, { cwd: rootDir, env, encoding: "utf8" });
  assert.match(second, /hot-reload without a GUI restart/);

  const codexConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(codexConfig, /active\.json/);
  assert.equal((codexConfig.match(/\[mcp_servers\.agent-link\]/g) || []).length, 1);
  console.log("INSTALL PASS: permanent MCP install is idempotent and targets active.json");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
