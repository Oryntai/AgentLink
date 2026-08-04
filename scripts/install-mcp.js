import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBridgeConfig } from "../src/config.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    result[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
  return result;
}

function run(command, args, { allowFailure = false } = {}) {
  const executable = process.platform === "win32" && command === "claude"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
    : command;
  const result = spawnSync(executable, args, { stdio: "inherit", shell: false });
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function tomlString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function installCodexDirect(mcpScript, configPath) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const codexConfigPath = path.join(codexHome, "config.toml");
  await mkdir(codexHome, { recursive: true });
  let original = "";
  try {
    original = await readFile(codexConfigPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = original.split(/\r?\n/);
  const header = "[mcp_servers.agent-link]";
  const start = lines.findIndex((line) => line.trim() === header);
  const desiredBlock = [
    header,
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(mcpScript)}, ${tomlString(configPath)}]`,
    "tool_timeout_sec = 86400",
    "required = true",
    'default_tools_approval_mode = "approve"',
  ];
  let end = lines.length;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\[/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const existingBlock = lines.slice(start, end);
    while (existingBlock.length && !existingBlock.at(-1).trim()) existingBlock.pop();
    if (existingBlock.join("\n") === desiredBlock.join("\n")) {
      console.log(`Permanent Codex MCP is already installed at ${codexConfigPath}`);
      return false;
    }
  }
  if (original) {
    const backup = `${codexConfigPath}.agent-link-backup`;
    await copyFile(codexConfigPath, backup);
    console.log(`Backup created: ${backup}`);
  }
  if (start >= 0) {
    lines.splice(start, end - start);
  }
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  lines.push(
    "",
    ...desiredBlock,
    "",
  );
  await writeFile(codexConfigPath, lines.join("\n"), "utf8");
  console.log(`Codex MCP written directly to ${codexConfigPath}`);
  return true;
}

async function installClaudeDesktopDirect(mcpScript, configPath) {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const claudeDir = path.join(appData, "Claude");
  const desktopConfigPath = path.join(claudeDir, "claude_desktop_config.json");
  await mkdir(claudeDir, { recursive: true });
  let desktopConfig = {};
  try {
    desktopConfig = JSON.parse(await readFile(desktopConfigPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  desktopConfig.mcpServers ||= {};
  const desiredEntry = {
    command: process.execPath,
    args: [mcpScript, configPath],
    env: { AGENT_LINK_CHANNEL_MODE: "0" },
  };
  if (JSON.stringify(desktopConfig.mcpServers["agent-link"]) === JSON.stringify(desiredEntry)) {
    console.log(`Permanent Claude Desktop MCP is already installed at ${desktopConfigPath}`);
    return false;
  }
  try {
    await copyFile(desktopConfigPath, `${desktopConfigPath}.agent-link-backup`);
    console.log(`Backup created: ${desktopConfigPath}.agent-link-backup`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  desktopConfig.mcpServers["agent-link"] = desiredEntry;
  await writeFile(desktopConfigPath, `${JSON.stringify(desktopConfig, null, 2)}\n`, "utf8");
  console.log(`Claude Desktop MCP written to ${desktopConfigPath}`);
  return true;
}

const args = parseArgs(process.argv.slice(2));
if (!args.config || !args.client) {
  console.error("Usage: node scripts/install-mcp.js --config PATH --client codex|claude|claude-desktop");
  process.exit(1);
}

const config = await loadBridgeConfig(args.config);
const mcpScript = path.join(rootDir, "src", "mcp-server.js");
const name = "agent-link";

if (args.client === "codex") {
  const changed = await installCodexDirect(mcpScript, config.configPath);
  console.log(changed
    ? "Permanent Codex MCP installed. Restart Codex Desktop once; future rooms hot-reload."
    : "Codex MCP is ready. The active room will hot-reload without a GUI restart.");
} else if (args.client === "claude") {
  run("claude", ["mcp", "remove", "--scope", "user", name], { allowFailure: true });
  run("claude", [
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    "user",
    name,
    "--env",
    `AGENT_LINK_CHANNEL_MODE=${config.channelMode ? "1" : "0"}`,
    "--",
    process.execPath,
    mcpScript,
    config.configPath,
  ]);
  console.log("Claude Code MCP installed.");
  if (config.channelMode) {
    console.log("Channel mode is experimental. Launch Claude Code with:");
    console.log("claude --dangerously-load-development-channels server:agent-link");
  }
} else if (args.client === "claude-desktop") {
  const changed = await installClaudeDesktopDirect(mcpScript, config.configPath);
  console.log(changed
    ? "Permanent Claude Desktop MCP installed. Restart Claude Desktop once; future rooms hot-reload."
    : "Claude Desktop MCP is ready. The active room will hot-reload without a GUI restart.");
} else {
  throw new Error("--client must be codex, claude, or claude-desktop");
}
