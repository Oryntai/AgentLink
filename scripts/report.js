import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBridgeConfig } from "../src/config.js";
import { decryptLogRecord } from "../src/log-crypto.js";

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--config") result.config = args[++i];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) throw new Error("Usage: npm run report -- --config PATH");
const config = await loadBridgeConfig(args.config);
const prefix = `${config.roomId}-${config.agentId}`;
const logFiles = (await readdir(config.logDir))
  .filter((name) => name.startsWith(prefix) && /\.jsonl(?:\.\d+)?$/.test(name))
  .map((name) => path.join(config.logDir, name));
const records = [];
for (const logFile of logFiles) {
  const content = await readFile(logFile, "utf8");
  records.push(
    ...content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => decryptLogRecord(config.identity.privateKey, JSON.parse(line))),
  );
}
records.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

const messages = records.filter((item) => ["message_sent", "message_received"].includes(item.event));
const failures = records.filter((item) => /failed|error/.test(item.event));
const reportDir = path.join(path.dirname(config.configPath), "reports");
const reportPath = path.join(reportDir, `${config.roomId}-${config.agentId}.md`);
const lines = [
  "# AgentLink session report",
  "",
  `- Room: \`${config.roomId}\``,
  `- Agent: \`${config.agentId}\` (${config.displayName})`,
  `- Events: ${records.length}`,
  `- Messages: ${messages.length}`,
  `- Failures: ${failures.length}`,
  `- Log files: ${logFiles.length}`,
  "",
  "## Conversation",
  "",
];

for (const item of messages) {
  lines.push(`### ${item.timestamp} — ${item.event}`);
  lines.push("");
  lines.push(`Kind: \`${item.kind || "chat"}\``);
  lines.push("");
  lines.push(item.text || "_(empty)_");
  lines.push("");
}

if (failures.length) {
  lines.push("## Failures", "");
  for (const item of failures) lines.push(`- ${item.timestamp}: ${item.event} — ${item.error || "unknown"}`);
  lines.push("");
}

await mkdir(reportDir, { recursive: true });
await writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
console.log(reportPath);
