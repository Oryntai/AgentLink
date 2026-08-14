import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRoom } from "../src/agent-configs.js";
import { parseInviteCode } from "../src/invite-code.js";
import { parseNamedArgs, validateAgentId, writeParticipantConfig } from "./setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`
Join someone else's AgentLink room as a guest:
  npm run guest -- --invite "al1...." --name "Alice"

A guest asks questions from the desktop window and needs no agent of its own:
no Codex, no Claude, no MCP installation. Open the window with:
  npm run desktop
`);
}

async function main() {
  const args = parseNamedArgs(process.argv.slice(2));
  if (args.help === "true") {
    usage();
    return;
  }
  if (!args.invite || args.invite === "true") throw new Error("--invite is required");
  const invite = parseInviteCode(args.invite);
  const agentId = args.agent && args.agent !== "true"
    ? args.agent
    : `guest-${invite.inviteId.slice(0, 8)}`;
  validateAgentId(agentId);

  const configDir = path.resolve(
    process.env.AGENT_LINK_CONFIG_DIR || path.join(rootDir, ".agent-link"),
  );
  const { activeConfigPath } = await writeParticipantConfig({
    configDir,
    relayUrl: invite.relayUrl,
    roomCode: invite.roomCode,
    agentId,
    displayName: args.name && args.name !== "true" ? args.name : agentId,
    role: "responder",
  });
  // The issuing side redeems the invite during the handshake, so the invite id
  // has to reach the config the broker will connect with.
  await applyRoom(configDir, {
    roomCode: invite.roomCode,
    roomName: invite.label,
    relayUrl: invite.relayUrl,
    inviteId: invite.inviteId,
  });

  console.log(`Guest config: ${activeConfigPath}`);
  console.log(`Room: ${invite.label || "unnamed"} (${invite.roomFingerprint})`);
  console.log(`Invite: single use, valid until ${invite.expiresAt}`);
  console.log("\nOpen the window and ask your question:\n  npm run desktop");
}

main().catch((error) => {
  console.error(`AgentLink guest join failed: ${error.message}`);
  usage();
  process.exitCode = 1;
});
