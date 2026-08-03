import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentity, createRoomCode, parseRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...rawArgs] = process.argv.slice(2);

function argsToObject(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
    result[key] = value;
  }
  return result;
}

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

const args = argsToObject(rawArgs);
if (!args.agent || !/^[A-Za-z0-9_-]{2,64}$/.test(args.agent)) {
  throw new Error("--agent is required and may contain only letters, digits, _ and -");
}

const roomCode = command === "create" ? createRoomCode() : args.code;
if (!roomCode) throw new Error("--code is required when joining a room");
parseRoomCode(roomCode);

const configDir = path.join(rootDir, ".agent-link");
const configPath = path.join(configDir, `${args.agent}.json`);
const config = {
  relayUrl: args.relay || "ws://127.0.0.1:8787/ws",
  roomCode,
  agentId: args.agent,
  displayName: args.name || args.agent,
  role: command === "create" ? "initiator" : "responder",
  channelMode: args.channel === "true",
  identity: createIdentity(),
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  logDir: path.join("logs", args.agent),
};

await mkdir(configDir, { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

console.log(`Config created: ${configPath}`);
console.log(`Role: ${config.role}`);
console.log(`Channel mode: ${config.channelMode}`);
console.log(`Room code (send privately to the second owner):\n${roomCode}`);
console.log(`\nInstall into a local client:\nnode scripts/install-mcp.js --config "${configPath}" --client codex`);
console.log(`node scripts/install-mcp.js --config "${configPath}" --client claude`);
console.log(`node scripts/install-mcp.js --config "${configPath}" --client claude-desktop`);
