import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(rootDir, ".agent-link");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonl(filePath) {
  try {
    return (await readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const names = (await readdir(configDir)).filter(
  (name) => name.endsWith(".json") && !name.endsWith(".state.json"),
);
if (!names.length) throw new Error(`No AgentLink configs found in ${configDir}`);

const participants = [];
const allEvents = [];
for (const name of names) {
  const configPath = path.join(configDir, name);
  const config = await readJson(configPath);
  const { roomId } = parseRoomCode(config.roomCode);
  const logDir = path.resolve(configDir, config.logDir || "logs");
  const logFile = path.join(logDir, `${roomId}-${config.agentId}.jsonl`);
  let session = { phase: "not_started" };
  try {
    session = await readJson(`${configPath}.state.json`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const events = await readJsonl(logFile);
  participants.push({
    agentId: config.agentId,
    displayName: config.displayName,
    role: config.role,
    roomId,
    phase: session.phase,
    logFile,
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
const diagnostics = allEvents.filter((event) =>
  event.event === "tool_called" || /failed|error|disconnect/.test(event.event),
);

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
if (!diagnostics.length) lines.push("_No diagnostic events._", "");
for (const item of diagnostics) {
  lines.push(
    `- ${item.timestamp} — ${item.agentId}: ${item.event}` +
      `${item.tool ? ` \`${item.tool}\`` : ""}` +
      `${item.error ? ` — ${item.error}` : ""}`,
  );
}

const reportsDir = path.join(configDir, "reports");
const outputPath = path.join(reportsDir, "latest-combined.md");
await mkdir(reportsDir, { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(outputPath);
