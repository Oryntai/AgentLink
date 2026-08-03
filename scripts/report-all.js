import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoomCode } from "../src/crypto.js";
import { decryptLogRecord } from "../src/log-crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(rootDir, ".agent-link");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonl(filePath, sensitiveKey) {
  try {
    return (await readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => decryptLogRecord(sensitiveKey, JSON.parse(line)));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const names = (await readdir(configDir)).filter(
  (name) =>
    name.endsWith(".json") &&
    !name.endsWith(".state.json") &&
    !name.endsWith(".trust.json"),
);
if (!names.length) throw new Error(`No AgentLink configs found in ${configDir}`);

const participants = [];
const allEvents = [];
for (const name of names) {
  const configPath = path.join(configDir, name);
  const config = await readJson(configPath);
  const { roomId } = parseRoomCode(config.roomCode);
  const logDir = path.resolve(configDir, config.logDir || "logs");
  const prefix = `${roomId}-${config.agentId}`;
  let logFiles = [];
  try {
    logFiles = (await readdir(logDir))
      .filter((entry) => entry.startsWith(prefix) && /\.jsonl(?:\.\d+)?$/.test(entry))
      .map((entry) => path.join(logDir, entry));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let session = { phase: "not_started" };
  try {
    session = await readJson(`${configPath}.state.json`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const events = (
    await Promise.all(logFiles.map((file) => readJsonl(file, config.identity.privateKey)))
  ).flat();
  participants.push({
    agentId: config.agentId,
    displayName: config.displayName,
    role: config.role,
    roomId,
    phase: session.phase,
    logFiles,
    events: events.length,
  });
  allEvents.push(...events);
}

allEvents.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
const messages = new Map();
for (const event of allEvents) {
  if (!["message_sent", "message_received"].includes(event.event) || !event.messageId) continue;
  const existing = messages.get(event.messageId);
  if (!existing || event.event === "message_sent") messages.set(event.messageId, event);
}
const conversation = [...messages.values()].sort((a, b) =>
  String(a.timestamp).localeCompare(String(b.timestamp)),
);
const diagnosticEvents = allEvents.filter((event) =>
  event.event === "tool_called" || /failed|error|disconnect|superseded/.test(event.event),
);
const diagnostics = new Map();
for (const event of diagnosticEvents) {
  const key = [event.agentId, event.event, event.tool || "", event.error || ""].join("|");
  const aggregate = diagnostics.get(key) || {
    agentId: event.agentId,
    event: event.event,
    tool: event.tool,
    error: event.error,
    count: 0,
    first: event.timestamp,
    last: event.timestamp,
  };
  aggregate.count += 1;
  aggregate.last = event.timestamp;
  diagnostics.set(key, aggregate);
}

const lines = ["# AgentLink combined report", "", "## Participants", ""];
for (const item of participants) {
  lines.push(
    `- **${item.displayName}** (\`${item.agentId}\`, ${item.role}): phase \`${item.phase}\`, ${item.events} events`,
  );
}
lines.push("", "## Conversation", "");
if (!conversation.length) lines.push("_No peer messages logged yet._", "");
for (const item of conversation) {
  lines.push(
    `### ${item.timestamp} — ${item.displayName || item.agentId} — ${item.kind || "chat"}`,
    "",
    item.text || "_(empty)_",
    "",
  );
}
lines.push("## Diagnostics", "");
if (!diagnostics.size) lines.push("_No diagnostic events._", "");
for (const item of diagnostics.values()) {
  lines.push(
    `- ${item.agentId}: ${item.event}` +
      `${item.tool ? ` \`${item.tool}\`` : ""}` +
      `${item.error ? ` — ${item.error}` : ""}` +
      ` — ${item.count} occurrence(s), ${item.first} … ${item.last}`,
  );
}

const reportsDir = path.join(configDir, "reports");
const outputPath = path.join(reportsDir, "latest-combined.md");
await mkdir(reportsDir, { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(outputPath);
