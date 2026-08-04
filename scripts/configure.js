import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomCode } from "../src/crypto.js";
import {
  parseNamedArgs,
  validateAgentId,
  writeParticipantConfig,
} from "./setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...rawArgs] = process.argv.slice(2);

function usage() {
  console.log(`
Create the first participant:
  npm run create-room -- --agent oryntai-codex --name "Oryntai Codex" --relay ws://127.0.0.1:8787/ws

Join from the second machine:
  npm run join-room -- --code ROOM_CODE --agent friend-claude --name "Friend Claude" --relay ws://HOST:8787/ws --channel
`);
}

if (!["create", "join"].includes(command)) {
  usage();
  process.exit(1);
}

const args = parseNamedArgs(rawArgs);
validateAgentId(args.agent);

const roomCode = command === "create" ? createRoomCode() : args.code;
if (!roomCode) throw new Error("--code is required when joining a room");

const configDir = path.join(rootDir, ".agent-link");
const { config, configPath, activeConfigPath } = await writeParticipantConfig({
  configDir,
  relayUrl: args.relay || "ws://127.0.0.1:8787/ws",
  roomCode,
  agentId: args.agent,
  displayName: args.name || args.agent,
  role: command === "create" ? "initiator" : "responder",
  channelMode: args.channel === "true",
});

console.log(`Config created: ${configPath}`);
console.log(`Active config updated: ${activeConfigPath}`);
console.log(`Role: ${config.role}`);
console.log(`Channel mode: ${config.channelMode}`);
console.log(`Room code (send privately to the second owner):\n${roomCode}`);
console.log(`\nInstall the permanent MCP once:\nnode scripts/install-mcp.js --config "${activeConfigPath}" --client codex`);
console.log(`node scripts/install-mcp.js --config "${activeConfigPath}" --client claude`);
console.log(`node scripts/install-mcp.js --config "${activeConfigPath}" --client claude-desktop`);
