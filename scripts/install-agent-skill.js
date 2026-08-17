import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootDir, "skills", "agentlink-messenger");

export async function installCodexAgentSkill({ codexHome } = {}) {
  const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const destination = path.join(home, "skills", "agentlink-messenger");
  await cp(sourcePath, destination, { recursive: true, force: true });
  return destination;
}

function readClient(args) {
  const position = args.indexOf("--client");
  return position >= 0 ? args[position + 1] : null;
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (executedPath === fileURLToPath(import.meta.url)) {
  const client = readClient(process.argv.slice(2));
  if (client !== "codex") {
    console.log("AgentLink skill installation is available for Codex. Claude receives the same routine from MCP instructions.");
  } else {
    const destination = await installCodexAgentSkill();
    console.log(`AgentLink Messenger skill installed at ${destination}`);
  }
}
