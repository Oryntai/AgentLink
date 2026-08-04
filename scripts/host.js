import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import ngrok from "@ngrok/ngrok";
import { createRoomCode } from "../src/crypto.js";
import {
  installMcp,
  parseNamedArgs,
  publicTunnelToRelayUrl,
  redactSecret,
  validateAgentId,
  validateClient,
  writeParticipantConfig,
} from "./setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`
Host a temporary AgentLink room through ngrok:
  PowerShell:
  $env:NGROK_AUTHTOKEN = "your-token"

  Windows Command Prompt:
  set "NGROK_AUTHTOKEN=your-token"

  npm run host -- --agent alice-codex --name "Alice Codex" --client codex

Clients: codex, claude, claude-desktop
Optional: --port 8787 --channel
`);
}

function parsePort(value) {
  const port = Number(value || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return port;
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is already in use`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

async function waitForRelay(relay, port) {
  let spawnError;
  relay.once("error", (error) => {
    spawnError = error;
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError) throw spawnError;
    if (relay.exitCode !== null) throw new Error(`Local relay exited with code ${relay.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The relay is still starting.
    }
    await delay(100);
  }
  throw new Error("Local relay did not become healthy within 10 seconds");
}

async function stopRelay(relay) {
  if (!relay || relay.exitCode !== null) return;
  const exited = new Promise((resolve) => relay.once("exit", resolve));
  relay.kill("SIGTERM");
  const result = await Promise.race([exited.then(() => "exited"), delay(5_000).then(() => "timeout")]);
  if (result === "timeout" && relay.exitCode === null) relay.kill("SIGKILL");
}

async function waitForStop(relay) {
  return new Promise((resolve, reject) => {
    const onSigint = () => resolve("SIGINT");
    const onSigterm = () => resolve("SIGTERM");
    const onExit = (code) => reject(new Error(`Local relay stopped unexpectedly with code ${code}`));
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    relay.once("exit", onExit);
    const clean = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      relay.off("exit", onExit);
    };
    relay.once("exit", clean);
  });
}

async function main() {
  const args = parseNamedArgs(process.argv.slice(2));
  if (args.help === "true") {
    usage();
    return;
  }
  validateAgentId(args.agent);
  validateClient(args.client);
  if (!process.env.NGROK_AUTHTOKEN) {
    throw new Error("NGROK_AUTHTOKEN is missing. Get a free token at https://dashboard.ngrok.com/get-started/your-authtoken and set it in this terminal only");
  }

  const port = parsePort(args.port);
  await assertPortAvailable(port);
  const roomCode = createRoomCode();
  const configDir = path.resolve(process.env.AGENT_LINK_CONFIG_DIR || path.join(rootDir, ".agent-link"));
  let relay;
  let listener;

  try {
    relay = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
      cwd: rootDir,
      env: {
        ...process.env,
        AGENT_LINK_HOST: "127.0.0.1",
        AGENT_LINK_PORT: String(port),
      },
      stdio: ["ignore", "inherit", "inherit"],
      shell: false,
    });
    await waitForRelay(relay, port);

    console.log("Opening a temporary ngrok tunnel...");
    listener = await ngrok.forward({
      addr: `127.0.0.1:${port}`,
      authtoken_from_env: true,
    });
    const publicRelayUrl = publicTunnelToRelayUrl(listener.url());
    const { activeConfigPath } = await writeParticipantConfig({
      configDir,
      relayUrl: `ws://127.0.0.1:${port}/ws`,
      roomCode,
      agentId: args.agent,
      displayName: args.name || args.agent,
      role: "initiator",
      channelMode: args.channel === "true",
    });

    installMcp({ rootDir, configPath: activeConfigPath, client: args.client });

    console.log("\n=== AGENTLINK IS LIVE ===");
    console.log(`Temporary relay: ${publicRelayUrl}`);
    console.log("\nSend this command privately to your friend after they run npm ci:");
    console.log(`npm run join -- --url "${publicRelayUrl}" --code "${roomCode}" --agent friend-agent --name "Friend Agent" --client codex`);
    console.log("\nThey should change --agent, --name, and --client if needed.");
    console.log("Keep this terminal open. Ctrl+C closes the temporary URL.");
    console.log("The permanent MCP hot-reloads this room. Restart the GUI only after the first AgentLink v0.3 install.\n");

    const signal = await waitForStop(relay);
    console.log(`\n${signal} received. Closing AgentLink...`);
  } finally {
    if (listener) {
      try {
        await listener.close();
      } catch (error) {
        console.error(`Could not close ngrok cleanly: ${redactSecret(error.message, process.env.NGROK_AUTHTOKEN)}`);
      }
    }
    await stopRelay(relay);
  }
}

main().catch((error) => {
  console.error(`AgentLink host failed: ${redactSecret(error.message, process.env.NGROK_AUTHTOKEN)}`);
  usage();
  process.exitCode = 1;
});
