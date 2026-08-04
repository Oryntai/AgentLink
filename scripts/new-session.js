import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomCode, parseRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(rootDir, ".agent-link");

function parseArgs(values) {
  const result = { roomCode: null, paths: [] };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--code") {
      result.roomCode = values[++index];
    } else if (values[index].startsWith("--")) {
      throw new Error(`Unknown option: ${values[index]}`);
    } else {
      result.paths.push(path.resolve(values[index]));
    }
  }
  if (result.roomCode === undefined) throw new Error("--code requires a room code");
  return result;
}

const args = parseArgs(process.argv.slice(2));
const configPaths = args.paths.length
  ? args.paths
  : (await readdir(configDir))
      .filter(
        (name) =>
          name.endsWith(".json") &&
          !name.endsWith(".state.json") &&
          !name.endsWith(".trust.json"),
      )
      .map((name) => path.join(configDir, name));

if (configPaths.length < 1 || configPaths.length > 2) {
  throw new Error("new-session expects one remote participant config or two local participant configs");
}

const roomCode = args.roomCode || createRoomCode();
parseRoomCode(roomCode);
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
const participants = [];
for (const configPath of configPaths) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config.identity?.privateKey) {
    throw new Error(`Missing identity in ${configPath}; run migrate-identity first`);
  }
  config.roomCode = roomCode;
  config.expiresAt = expiresAt;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    `${configPath}.state.json`,
    `${JSON.stringify({ phase: "negotiating_goal", goal: null, successCriteria: [] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  participants.push(`${config.agentId}:${config.role}`);
}

console.log(`New AgentLink session: ${participants.join(", ")}`);
console.log(`Expires: ${expiresAt}`);
if (!args.roomCode) {
  console.log("Room code (share privately with the peer owner):");
  console.log(roomCode);
} else {
  console.log("The supplied room code was installed.");
}
