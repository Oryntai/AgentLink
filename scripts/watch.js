import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { parseNamedArgs } from "./setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseNamedArgs(process.argv.slice(2));
const configPath = path.resolve(
  args["config-path"] || process.env.AGENT_LINK_CONFIG || path.join(rootDir, ".agent-link", "active.json"),
);
const timeoutSeconds = Number(args["wait-seconds"] || 86_400);
process.env.AGENT_LINK_CLIENT_TYPE = args.client || "claude-code";
process.env.AGENT_LINK_WAKE_MODE = "background_watcher";
if (args["task-id"]) process.env.AGENT_LINK_TASK_ID = args["task-id"];
if (args.tags) process.env.AGENT_LINK_TAGS = args.tags;
if (args.workspace) process.env.AGENT_LINK_WORKSPACE = args.workspace;

const config = await loadBridgeConfig(configPath);
const broker = new BrokerClient(config);
try {
  await broker.connect();
  const request = await broker.watch(timeoutSeconds * 1_000);
  process.stdout.write(
    `AgentLink request queued from ${request.displayName}. `
      + `Open the AgentLink inbox and claim request ${request.requestId}.\n`,
  );
} finally {
  await broker.close();
}
