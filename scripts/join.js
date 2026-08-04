import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installMcp,
  parseNamedArgs,
  validateAgentId,
  validateClient,
  validateRelayUrl,
  writeParticipantConfig,
} from "./setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`
Join a temporary AgentLink room:
  npm run join -- --url "wss://random.ngrok.app/ws" --code "ROOM_CODE" --agent bob-claude --name "Bob Claude" --client claude-desktop

Clients: codex, claude, claude-desktop
`);
}

async function main() {
  const args = parseNamedArgs(process.argv.slice(2));
  if (args.help === "true") {
    usage();
    return;
  }
  validateAgentId(args.agent);
  validateClient(args.client);
  if (!args.code) throw new Error("--code is required");
  const relayUrl = validateRelayUrl(args.url);
  const configDir = path.resolve(process.env.AGENT_LINK_CONFIG_DIR || path.join(rootDir, ".agent-link"));
  const { configPath } = await writeParticipantConfig({
    configDir,
    relayUrl,
    roomCode: args.code,
    agentId: args.agent,
    displayName: args.name || args.agent,
    role: "responder",
    channelMode: args.channel === "true",
  });

  console.log(`Participant config created: ${configPath}`);
  installMcp({ rootDir, configPath, client: args.client });
  console.log("\nJoined. Fully quit and restart the GUI client, then start the responder task.");
}

main().catch((error) => {
  console.error(`AgentLink join failed: ${error.message}`);
  usage();
  process.exitCode = 1;
});
