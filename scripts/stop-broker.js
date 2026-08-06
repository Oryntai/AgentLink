import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { brokerEndpoint } from "../src/broker-endpoint.js";

function parseArgs(argv) {
  const options = { config: process.env.AGENT_LINK_CONFIG || ".agent-link/active.json", yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "--config" || argument === "-c") options.config = argv[++index];
    else if (argument.startsWith("--config=")) options.config = argument.slice("--config=".length);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.config) throw new Error("--config requires a path");
  return options;
}

function describeLiveBroker(endpoint, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    const finish = (value) => {
      socket.destroy();
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", () => finish(null));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: "stop", method: "hello", params: {} })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        finish(message.ok ? message.result : null);
      } catch {
        finish(null);
      }
    });
  });
}

function processCandidates(configPath) {
  const rows = [];
  try {
    if (process.platform === "win32") {
      const raw = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ], { encoding: "utf8", windowsHide: true });
      const parsed = JSON.parse(raw || "[]");
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item?.ProcessId) rows.push({ pid: Number(item.ProcessId), command: item.CommandLine || "" });
      }
    } else {
      const raw = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
      for (const line of raw.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (match) rows.push({ pid: Number(match[1]), command: match[2] });
      }
    }
  } catch {
    return [];
  }
  const needle = process.platform === "win32" ? configPath.toLowerCase() : configPath;
  return rows.filter((row) => {
    if (row.pid === process.pid) return false;
    const command = process.platform === "win32" ? row.command.toLowerCase() : row.command;
    return command.includes("broker-server.js") && command.includes(needle);
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function confirm(question, preapproved) {
  if (preapproved) return true;
  if (!process.stdin.isTTY) {
    console.error("Refusing to stop a broker without confirmation. Re-run with --yes from a script.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("Usage: npm run stop-broker -- --config .agent-link/active.json [--yes]");
  process.exit(0);
}

const configPath = path.resolve(options.config);
const endpoint = brokerEndpoint(configPath);
const runtimePath = `${configPath}.broker-runtime.json`;

const live = await describeLiveBroker(endpoint);
let runtime = null;
try {
  runtime = JSON.parse(await readFile(runtimePath, "utf8"));
} catch {
  runtime = null;
}

let target = null;
if (live?.pid) {
  target = { pid: live.pid, command: `broker protocol ${live.brokerProtocol}, started ${live.startedAt}` };
  if (runtime && (runtime.pid !== live.pid || runtime.startedAt !== live.startedAt || runtime.endpoint !== live.endpoint)) {
    console.warn(`Ignoring stale ${runtimePath}: it does not match the live broker.`);
  }
} else {
  const candidates = processCandidates(configPath);
  if (candidates.length > 1) {
    console.error(`Found ${candidates.length} broker processes for this config; stop them manually:`);
    for (const candidate of candidates) console.error(`  pid ${candidate.pid}: ${candidate.command}`);
    process.exit(1);
  }
  target = candidates[0] || null;
}

if (!target) {
  console.log(`No AgentLink broker is running for ${configPath}.`);
  process.exit(0);
}

console.log(`Config:   ${configPath}`);
console.log(`Endpoint: ${endpoint}`);
console.log(`PID:      ${target.pid}`);
console.log(`Process:  ${target.command}`);
console.log(live ? "Verified: answered hello on the local endpoint." : "Verified: matched by command line only (legacy broker).");

if (!(await confirm(`Stop broker ${target.pid}?`, options.yes))) {
  console.log("Left the broker running.");
  process.exit(1);
}

try {
  process.kill(target.pid, "SIGTERM");
} catch (error) {
  console.error(`Could not signal pid ${target.pid}: ${error.message}`);
  process.exit(1);
}

const deadline = Date.now() + 10_000;
while (Date.now() < deadline && alive(target.pid)) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (alive(target.pid)) {
  console.error(`Broker ${target.pid} is still running. Stop it manually.`);
  process.exit(1);
}
console.log(`Stopped broker ${target.pid}. In-flight requests return to the queue on the next start.`);
