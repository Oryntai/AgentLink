import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { createIdentity, createRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpScript = path.join(rootDir, "src", "mcp-server.js");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForRelay(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Relay did not start")), 10_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("AgentLink relay listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`Relay exited early: ${code}\n${output}`)));
  });
}

function textOf(result) {
  return result.content?.find((item) => item.type === "text")?.text || "";
}

async function makeClient(name, configPath, onChannel) {
  const client = new Client(
    { name, version: "0.1.0" },
    { capabilities: { experimental: { "claude/channel": {} } } },
  );
  if (onChannel) {
    const ChannelSchema = z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()).optional(),
      }),
    });
    client.setNotificationHandler(ChannelSchema, onChannel);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpScript, configPath],
    cwd: rootDir,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-mcp-test-"));
const port = await freePort();
const relayUrl = `ws://127.0.0.1:${port}/ws`;
const roomCode = createRoomCode();
const alicePath = path.join(tempDir, "alice.json");
const bobPath = path.join(tempDir, "bob.json");
await writeFile(alicePath, JSON.stringify({
  relayUrl,
  roomCode,
  agentId: "alice-codex",
  displayName: "Alice Codex",
  role: "initiator",
  identity: createIdentity(),
  channelMode: false,
  logDir: "logs/alice",
}));
await writeFile(bobPath, JSON.stringify({
  relayUrl,
  roomCode,
  agentId: "bob-claude",
  displayName: "Bob Claude",
  role: "responder",
  identity: createIdentity(),
  channelMode: true,
  logDir: "logs/bob",
}));

const relay = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
  cwd: rootDir,
  env: {
    ...process.env,
    AGENT_LINK_HOST: "127.0.0.1",
    AGENT_LINK_PORT: String(port),
    AGENT_LINK_DATA_FILE: path.join(tempDir, "relay-state.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let alice;
let bob;
const channelEvents = [];
try {
  await waitForRelay(relay);
  alice = await makeClient("alice-test", alicePath);
  bob = await makeClient("bob-test", bobPath, (notification) => {
    channelEvents.push(notification.params);
  });

  const aliceTools = await alice.client.listTools();
  assert(aliceTools.tools.some((tool) => tool.name === "peer_exchange"));

  const propose = alice.client.callTool({
    name: "peer_goal",
    arguments: {
      action: "propose",
      goal: "Agree on the button interface",
      success_criteria: ["Name", "States"],
      timeout_seconds: 10,
    },
  });
  const waitedGoal = await bob.client.callTool({
    name: "peer_goal",
    arguments: { action: "wait", timeout_seconds: 10 },
  });
  assert.match(textOf(waitedGoal), /Agree on the button interface/);
  const accepted = await bob.client.callTool({
    name: "peer_goal",
    arguments: { action: "accept", note: "Goal and criteria accepted" },
  });
  assert.match(textOf(accepted), /Goal accepted/);
  assert.match(textOf(await propose), /accepted the goal/);

  const aliceExchange = alice.client.callTool({
    name: "peer_exchange",
    arguments: { message: "What should we call the component?", timeout_seconds: 10 },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(channelEvents.some((event) => /What should we call the component/.test(event.content)));
  await bob.client.callTool({
    name: "peer_reply",
    arguments: { message: "Call the component PaymentButton" },
  });
  assert.match(textOf(await aliceExchange), /PaymentButton/);

  const finishProposal = alice.client.callTool({
    name: "peer_complete",
    arguments: {
      action: "propose",
      summary: "The name and states are agreed",
      timeout_seconds: 10,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(channelEvents.some((event) => /proposes ending the conversation/.test(event.content)));
  await bob.client.callTool({
    name: "peer_complete",
    arguments: { action: "accept", note: "Completion confirmed" },
  });
  assert.match(textOf(await finishProposal), /confirmed completion/);

  const status = await alice.client.callTool({ name: "peer_status", arguments: {} });
  assert.match(textOf(status), /finished/);
  assert.equal(status.structuredContent.connected, false);
  const bobStatus = await bob.client.callTool({ name: "peer_status", arguments: {} });
  assert.equal(bobStatus.structuredContent.connected, false);
  console.log("MCP PASS: stdio tools, blocking exchange, Claude push channel, goal, finish, and auto-disconnect verified");
} finally {
  await Promise.allSettled([alice?.client.close(), bob?.client.close()]);
  relay.kill("SIGTERM");
  await new Promise((resolve) => relay.once("exit", resolve));
  if (!process.env.KEEP_AGENT_LINK_TEST_DATA) await rm(tempDir, { recursive: true, force: true });
}
