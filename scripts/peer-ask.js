import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseNamedArgs } from "./setup-lib.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseNamedArgs(process.argv.slice(2));
const configPath = path.resolve(args.config || path.join(rootDir, ".agent-link", "active.json"));
const timeoutSeconds = Number(args.timeout || 86_400);

async function readQuestion() {
  if (args.question) return args.question.trim();
  let value = "";
  for await (const chunk of process.stdin) value += chunk.toString("utf8");
  return value.trim();
}

const question = await readQuestion();
if (!question) throw new Error("Provide --question TEXT or pipe the question on stdin");

const client = new Client({ name: "agent-link-peer-ask", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(rootDir, "src", "mcp-server.js"), configPath],
  cwd: rootDir,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "peer_ask",
    arguments: {
      question,
      timeout_seconds: timeoutSeconds,
      ...(args["request-id"] ? { request_id: args["request-id"] } : {}),
      ...(args["task-id"] ? { task_id: args["task-id"] } : {}),
      ...(args["workspace-hint"] ? { workspace_hint: args["workspace-hint"] } : {}),
      ...(args.tags ? { tags: args.tags.split(",").map((tag) => tag.trim()).filter(Boolean) } : {}),
      ...(args.deadline ? { deadline: args.deadline } : {}),
    },
  }, undefined, { timeout: (timeoutSeconds + 5) * 1_000 });
  const response = result.content?.find((item) => item.type === "text")?.text;
  if (!response) throw new Error("Peer returned no text response");
  process.stdout.write(`${response}\n`);
} catch (error) {
  if (stderr.trim()) process.stderr.write(stderr);
  throw error;
} finally {
  await client.close().catch(() => {});
}
