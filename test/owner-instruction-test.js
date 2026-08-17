import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { createRoomCode } from "../src/crypto.js";
import { DESKTOP_BROKER_METHODS } from "../src/protocol-version.js";
import { writeParticipantConfig } from "../scripts/setup-lib.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-link-owner-instruction-test-"));
const previousIdleExit = process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS;
let desktop;
let agent;

try {
  process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = "50";
  const participant = await writeParticipantConfig({
    configDir: tempDir,
    relayUrl: "ws://127.0.0.1:1/ws",
    roomCode: createRoomCode(),
    agentId: "owner-instruction-test",
    displayName: "Developer",
    role: "initiator",
    activate: false,
  });
  const config = await loadBridgeConfig(participant.configPath);
  desktop = new BrokerClient(config, {
    requiredMethods: DESKTOP_BROKER_METHODS,
    clientType: "desktop",
  });
  agent = new BrokerClient(config);
  await desktop.connect();
  await agent.connect();

  await assert.rejects(
    agent.ownerRequestSend("This must stay owner-only"),
    /Only the owner desktop window/,
    "a regular agent frontend must not inject owner messages",
  );

  const sent = await desktop.ownerRequestSend("Pause and explain the current risk to me.");
  assert.equal(sent.state, "queued");

  // Owner instructions deliberately have no deadline. Let the broker's
  // maintenance pass run once to guard against treating a missing date as an
  // old timestamp and expiring the instruction before an agent can claim it.
  await new Promise((resolve) => setTimeout(resolve, 5_200));
  const inbox = await agent.listInbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].ownerMessage, true);
  assert.equal(inbox[0].displayName, "Owner");

  const queuedTranscript = await desktop.listTranscript({ limit: 10 });
  const queuedInstruction = queuedTranscript.messages.find((item) => item.kind === "owner_request");
  assert.equal(queuedInstruction.state, "queued");

  const claimed = await agent.claimInbox(sent.requestId);
  assert.equal(claimed.metadata.ownerMessage, true);
  await agent.markProcessing(sent.requestId);
  const response = await agent.respond(sent.requestId, "The main risk is an unclaimed profile looking active.");
  assert.equal(response.ownerOnly, true);

  const transcript = await desktop.listTranscript({ limit: 10 });
  const instruction = transcript.messages.find((item) => item.kind === "owner_request");
  const answer = transcript.messages.find((item) => item.kind === "owner_response");
  assert.equal(instruction.text, "Pause and explain the current risk to me.");
  assert.equal(instruction.state, "responded");
  assert.equal(answer.text, "The main risk is an unclaimed profile looking active.");
  assert.equal(answer.author, "Developer");

  const brokerFile = (await readdir(tempDir)).find((name) => name.endsWith(".broker.json"));
  const encryptedStore = await readFile(path.join(tempDir, brokerFile), "utf8");
  assert.doesNotMatch(encryptedStore, /Pause and explain|unclaimed profile/);
  console.log("OWNER INSTRUCTION PASS: owner messages stay local, encrypted, and reply through the inbox flow");
} finally {
  await desktop?.close().catch(() => {});
  await agent?.close().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (previousIdleExit === undefined) delete process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS;
  else process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS = previousIdleExit;
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
