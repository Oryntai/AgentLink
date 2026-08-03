import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomCode } from "../src/crypto.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(rootDir, ".agent-link");
const explicitPaths = process.argv.slice(2).map((item) => path.resolve(item));
const configPaths = explicitPaths.length
  ? explicitPaths
  : (await readdir(configDir))
      .filter(
        (name) =>
          name.endsWith(".json") &&
          !name.endsWith(".state.json") &&
          !name.endsWith(".trust.json"),
      )
      .map((name) => path.join(configDir, name));

if (configPaths.length !== 2) {
  throw new Error("new-session expects exactly two local participant config paths");
}

const roomCode = createRoomCode();
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
console.log("Room code (share privately only when the peer is on another machine):");
console.log(roomCode);
