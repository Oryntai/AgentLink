import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRoomCode } from "../src/crypto.js";
import { saveLocalDuo } from "../src/local-duo.js";
import { writeParticipantConfig } from "../scripts/setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpScript = path.join(rootDir, "src", "mcp-server.js");

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForRelay(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("relay did not start")), 10_000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("AgentLink relay listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`relay exited early: ${code}`)));
  });
}

async function localDuoClient(name, bootstrapConfig) {
  const client = new Client({ name, version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpScript, bootstrapConfig],
    cwd: rootDir,
    stderr: "pipe",
    env: { ...process.env, AGENT_LINK_NOTIFY: "0", AGENT_LINK_BROKER_IDLE_EXIT_MS: "100" },
  });
  await client.connect(transport);
  return { client, transport };
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-local-duo-mcp-test-"));
const port = await freePort();
const relayUrl = `ws://127.0.0.1:${port}/ws`;
const relay = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
  cwd: rootDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    AGENT_LINK_HOST: "127.0.0.1",
    AGENT_LINK_PORT: String(port),
    AGENT_LINK_DATA_FILE: path.join(tempDir, "relay.json"),
  },
});
let developerTask;
let reviewerTask;

try {
  await waitForRelay(relay);
  const roomCode = createRoomCode();
  const developer = await writeParticipantConfig({
    configDir: tempDir,
    relayUrl,
    roomCode,
    agentId: "local-developer",
    displayName: "Developer",
    role: "initiator",
    activate: false,
  });
  const reviewer = await writeParticipantConfig({
    configDir: tempDir,
    relayUrl,
    roomCode,
    agentId: "local-reviewer",
    displayName: "Reviewer",
    role: "responder",
    activate: false,
  });
  await saveLocalDuo(tempDir, {
    version: 1,
    roomName: "Local build review",
    relayUrl,
    createdAt: new Date().toISOString(),
    profiles: [
      { id: "developer", agentId: developer.config.agentId, displayName: "Developer", role: "initiator", workspace: tempDir, configPath: developer.configPath, claim: null },
      { id: "reviewer", agentId: reviewer.config.agentId, displayName: "Reviewer", role: "responder", workspace: tempDir, configPath: reviewer.configPath, claim: null },
    ],
  });

  const bootstrap = path.join(tempDir, "active.json");
  developerTask = await localDuoClient("developer-task", bootstrap);
  reviewerTask = await localDuoClient("reviewer-task", bootstrap);
  const tools = await developerTask.client.listTools();
  assert(tools.tools.some((tool) => tool.name === "peer_local_duo_claim"));
  const roster = await developerTask.client.callTool({ name: "peer_local_duo_status", arguments: {} });
  assert.equal(roster.structuredContent.enabled, true);
  assert.equal(roster.structuredContent.profiles.length, 2);
  const claimDeveloper = await developerTask.client.callTool({
    name: "peer_local_duo_claim",
    arguments: { profile_id: "developer" },
  });
  assert.equal(claimDeveloper.structuredContent.agentId, "local-developer");
  const duplicate = await reviewerTask.client.callTool({
    name: "peer_local_duo_claim",
    arguments: { profile_id: "developer" },
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already claimed/);
  const claimReviewer = await reviewerTask.client.callTool({
    name: "peer_local_duo_claim",
    arguments: { profile_id: "reviewer" },
  });
  assert.equal(claimReviewer.structuredContent.agentId, "local-reviewer");
  assert.equal((await developerTask.client.callTool({ name: "peer_status", arguments: {} })).structuredContent.connected, true);
  assert.equal((await reviewerTask.client.callTool({ name: "peer_status", arguments: {} })).structuredContent.connected, true);
  console.log("LOCAL DUO MCP PASS: two Codex sessions claim separate local identities");
} finally {
  await developerTask?.client.close().catch(() => {});
  await reviewerTask?.client.close().catch(() => {});
  relay.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
