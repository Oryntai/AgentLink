import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BridgeClient } from "./bridge-client.js";
import { loadBridgeConfig } from "./config.js";

const configPath = path.resolve(
  process.argv[2] || process.env.AGENT_LINK_CONFIG || ".agent-link/active.json",
);
let activeContext = null;
let lastReloadError = null;
let mcpReady = false;
let reloadQueue = Promise.resolve();
const configuredOpenRequestLimit = Number(process.env.AGENT_LINK_MAX_OPEN_REQUESTS || 500);
const maxOpenRequests = Number.isInteger(configuredOpenRequestLimit) && configuredOpenRequestLimit > 0
  ? configuredOpenRequestLimit
  : 500;

async function loadState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { phase: "negotiating_goal", goal: null, successCriteria: [] };
  }
}

async function saveState(context, patch) {
  if (context !== activeContext) throw new Error("AgentLink configuration changed during this operation");
  context.state = { ...context.state, ...patch, updatedAt: new Date().toISOString() };
  const snapshot = context.state;
  const operation = context.stateSaveQueue.catch(() => {}).then(async () => {
    await mkdir(path.dirname(context.stateFile), { recursive: true });
    const temporaryPath = `${context.stateFile}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, context.stateFile);
  });
  context.stateSaveQueue = operation;
  await operation;
}

function naturalMessage(message) {
  const sender = message.metadata?.displayName || message.from;
  const labels = {
    chat: `Message from agent ${sender}`,
    request: `Read-only request from agent ${sender}`,
    response: `Read-only response from agent ${sender}`,
    goal_proposal: `Final-goal proposal from agent ${sender}`,
    goal_accept: `Agent ${sender} accepted the goal`,
    goal_reject: `Agent ${sender} rejected the goal`,
    finish_proposal: `Agent ${sender} proposes completing the current goal`,
    finish_accept: `Agent ${sender} confirmed goal completion`,
    finish_reject: `Agent ${sender} rejected goal completion`,
    escalation: `Agent ${sender} requests human intervention`,
  };
  return `${labels[message.kind] || `Event from agent ${sender}`}:\n${message.text}`;
}

function result(text, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: extra,
  };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: "text", text: `AgentLink error: ${error.message}` }],
  };
}

function trackOpenRequest(context, message) {
  context.openRequests.set(message.id, message);
  while (context.openRequests.size > maxOpenRequests) {
    context.openRequests.delete(context.openRequests.keys().next().value);
  }
}

const mcp = new Server(
  { name: "agent-link", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "AgentLink is a persistent encrypted link to one trusted peer agent. The transport stays connected across individual goals. " +
      "For an ad-hoc read-only question, call peer_ask and remain suspended while the peer inspects its own machine. " +
      "To serve the peer, keep peer_listen pending; after it returns, inspect local files or databases with local read-only tools, " +
      "call peer_respond with the request ID, then call peer_listen again. No peer receives direct machine or tool access. " +
      "Never disclose credentials, tokens, .env contents, or unrelated data. Structured planning may still use peer_goal, " +
      "peer_exchange, and peer_complete; completing a goal does not close the persistent transport.",
  },
);

async function onBridgeMessage(context, message) {
  if (context !== activeContext) return;
  if (message.kind === "request") {
    trackOpenRequest(context, message);
  } else if (message.kind === "goal_proposal") {
    await saveState(context, {
      phase: "goal_proposed_by_peer",
      goal: message.text,
      successCriteria: message.metadata?.successCriteria || [],
    });
  } else if (message.kind === "goal_accept") {
    await saveState(context, { phase: "active", peerGoalAccepted: true });
  } else if (message.kind === "goal_reject") {
    await saveState(context, { phase: "negotiating_goal", peerGoalAccepted: false });
  } else if (message.kind === "finish_proposal") {
    await saveState(context, { phase: "finish_proposed_by_peer", finishSummary: message.text });
  } else if (message.kind === "finish_accept") {
    await saveState(context, { phase: "finished", peerFinishAccepted: true });
  } else if (message.kind === "finish_reject") {
    await saveState(context, { phase: "active", peerFinishAccepted: false });
  }

  if (context.config.channelMode && mcpReady) {
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: naturalMessage(message),
          meta: {
            room_id: context.config.roomId,
            sender_id: message.from,
            message_id: message.id,
            kind: message.kind,
          },
        },
      });
      if (message.kind !== "request") context.bridge.discard(message.id);
    } catch (error) {
      await context.bridge.log.write("channel_push_failed", { error: error.message });
    }
  }
}

async function reloadConfigNow() {
  const rawConfig = await readFile(configPath, "utf8");
  const fingerprint = createHash("sha256").update(rawConfig).digest("hex");
  if (activeContext?.fingerprint === fingerprint) return activeContext;

  const config = await loadBridgeConfig(configPath);
  const stateFile = `${config.configPath}.${config.roomId}.state.json`;
  const context = {
    config,
    stateFile,
    state: await loadState(stateFile),
    bridge: new BridgeClient(config),
    fingerprint,
    openRequests: new Map(),
    stateSaveQueue: Promise.resolve(),
  };
  context.bridge.on("message", (message) => {
    void onBridgeMessage(context, message).catch((error) =>
      context.bridge.log.write("message_handler_failed", { error: error.message }),
    );
  });

  const previous = activeContext;
  activeContext = context;
  lastReloadError = null;
  if (mcpReady) void context.bridge.start();
  if (previous) await previous.bridge.close();
  return context;
}

function refreshConfig() {
  const operation = reloadQueue.then(() => reloadConfigNow());
  reloadQueue = operation.catch(() => {});
  return operation;
}

const tools = [
  {
    name: "peer_status",
    description: "Show persistent-link status, active config, peer state, and current structured-goal phase.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "peer_ask",
    description:
      "Ask the peer an ad-hoc question and wait while it leaves AgentLink to perform local read-only inspection. The model generates no tokens while this tool is pending.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_listen",
    description:
      "Wait for the peer's next ad-hoc request. After this returns, inspect only the necessary local data, call peer_respond with its request ID, then call peer_listen again.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "peer_respond",
    description:
      "Answer one request returned by peer_listen after completing the necessary local read-only work. Then return to peer_listen.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
      },
      required: ["request_id", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_goal",
    description:
      "Optionally negotiate a structured final goal. Initiator uses propose; responder uses wait then accept/reject.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["propose", "wait", "accept", "reject"] },
        goal: { type: "string" },
        success_criteria: { type: "array", items: { type: "string" } },
        note: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_exchange",
    description:
      "Radio-style structured-goal exchange: optionally send one chat message, then suspend until the peer replies.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "peer_reply",
    description: "Send an uncorrelated chat reply for structured goals or Claude channel events.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1 } },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_complete",
    description:
      "Mutually complete the current structured goal. The persistent AgentLink transport remains connected for later requests.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["propose", "accept", "reject"] },
        summary: { type: "string" },
        note: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "peer_escalate",
    description: "Send a concise request for human intervention when the agents cannot converge.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", minLength: 1 } },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments || {};
  let context;
  try {
    context = await refreshConfig();
    const persistentWait = params.name === "peer_ask" || params.name === "peer_listen";
    const timeoutMs = Number(args.timeout_seconds || (persistentWait ? 86400 : 3600)) * 1000;
    await context.bridge.log.write("tool_called", { tool: params.name, arguments: args });
    await context.bridge.connect();

    if (params.name === "peer_status") {
      const status = {
        ...context.bridge.status(),
        persistent: true,
        hotReload: true,
        configPath,
        configReloadError: lastReloadError,
        openRequests: context.openRequests.size,
        session: context.state,
      };
      return result(JSON.stringify(status, null, 2), status);
    }

    if (params.name === "peer_ask") {
      const question = args.question?.trim();
      if (!question) throw new Error("question is required");
      const requestId = await context.bridge.send(question, {
        kind: "request",
        metadata: { displayName: context.config.displayName },
      });
      const incoming = await context.bridge.wait({
        kinds: ["response"],
        predicate: (message) => message.metadata?.replyTo === requestId,
        timeoutMs,
      });
      return result(naturalMessage(incoming), { requestId, message: incoming });
    }

    if (params.name === "peer_listen") {
      const incoming = await context.bridge.wait({ kinds: ["request"], timeoutMs });
      trackOpenRequest(context, incoming);
      return result(
        `${naturalMessage(incoming)}\n\nRequest ID: ${incoming.id}\nPerform the necessary local read-only work, call peer_respond with this request_id, then call peer_listen again.`,
        { request: incoming },
      );
    }

    if (params.name === "peer_respond") {
      const requestId = args.request_id?.trim();
      const message = args.message?.trim();
      if (!requestId || !message) throw new Error("request_id and message are required");
      if (!context.openRequests.has(requestId)) {
        throw new Error("Unknown or already answered request_id; call peer_listen first");
      }
      const responseId = await context.bridge.send(message, {
        kind: "response",
        metadata: { displayName: context.config.displayName, replyTo: requestId },
      });
      context.openRequests.delete(requestId);
      context.bridge.discard(requestId);
      return result("Response sent. Call peer_listen again to keep serving future requests.", {
        requestId,
        responseId,
      });
    }

    if (params.name === "peer_goal") {
      if (args.action === "propose") {
        if (context.config.role !== "initiator") {
          throw new Error("Only the initiator may propose the first goal");
        }
        if (!args.goal?.trim()) throw new Error("goal is required");
        const criteria = args.success_criteria || [];
        await saveState(context, {
          phase: "goal_proposed",
          goal: args.goal.trim(),
          successCriteria: criteria,
        });
        await context.bridge.send(args.goal.trim(), {
          kind: "goal_proposal",
          metadata: { displayName: context.config.displayName, successCriteria: criteria },
        });
        const reply = await context.bridge.wait({
          kinds: ["goal_accept", "goal_reject"],
          timeoutMs,
        });
        return result(naturalMessage(reply), { message: reply, session: context.state });
      }
      if (args.action === "wait") {
        const proposal = await context.bridge.wait({ kinds: ["goal_proposal"], timeoutMs });
        return result(naturalMessage(proposal), { message: proposal, session: context.state });
      }
      if (!["goal_proposed_by_peer", "negotiating_goal"].includes(context.state.phase)) {
        throw new Error(`Cannot ${args.action} goal while phase is ${context.state.phase}`);
      }
      const accepted = args.action === "accept";
      await context.bridge.send(
        args.note || (accepted ? "Goal accepted." : "The goal needs clarification."),
        {
          kind: accepted ? "goal_accept" : "goal_reject",
          metadata: { displayName: context.config.displayName },
        },
      );
      await saveState(context, {
        phase: accepted ? "active" : "negotiating_goal",
        localGoalAccepted: accepted,
      });
      return result(
        accepted ? "Goal accepted. The structured conversation may begin." : "Rejection sent.",
        { session: context.state },
      );
    }

    if (params.name === "peer_exchange") {
      if (context.state.phase !== "active") {
        throw new Error(`Conversation is not active; current phase is ${context.state.phase}`);
      }
      const incoming = await context.bridge.exchange(args.message?.trim(), {
        kind: "chat",
        metadata: { displayName: context.config.displayName },
        timeoutMs,
      });
      return result(naturalMessage(incoming), { message: incoming });
    }

    if (params.name === "peer_reply") {
      if (context.state.phase !== "active" && context.state.phase !== "finish_proposed_by_peer") {
        throw new Error(`Conversation is not active; current phase is ${context.state.phase}`);
      }
      const id = await context.bridge.send(args.message.trim(), {
        kind: "chat",
        metadata: { displayName: context.config.displayName },
      });
      return result("Reply sent.", { messageId: id });
    }

    if (params.name === "peer_complete") {
      if (args.action === "propose") {
        if (context.state.phase !== "active") {
          throw new Error(`Cannot complete while phase is ${context.state.phase}`);
        }
        if (!args.summary?.trim()) throw new Error("summary is required");
        await saveState(context, { phase: "finish_proposed", finishSummary: args.summary.trim() });
        await context.bridge.send(args.summary.trim(), {
          kind: "finish_proposal",
          metadata: { displayName: context.config.displayName },
        });
        const reply = await context.bridge.wait({
          kinds: ["finish_accept", "finish_reject"],
          timeoutMs,
        });
        return result(naturalMessage(reply), { message: reply, session: context.state });
      }
      if (context.state.phase !== "finish_proposed_by_peer") {
        throw new Error(`No peer completion proposal is pending; current phase is ${context.state.phase}`);
      }
      const accepted = args.action === "accept";
      await context.bridge.send(
        args.note || (accepted ? "Completion confirmed." : "The goal has not been reached yet."),
        {
          kind: accepted ? "finish_accept" : "finish_reject",
          metadata: { displayName: context.config.displayName },
        },
      );
      await saveState(context, {
        phase: accepted ? "finished" : "active",
        localFinishAccepted: accepted,
      });
      return result(
        accepted
          ? "Current goal completed by mutual agreement. The persistent link remains connected."
          : "The current goal will continue.",
        { session: context.state },
      );
    }

    if (params.name === "peer_escalate") {
      const id = await context.bridge.send(args.question.trim(), {
        kind: "escalation",
        metadata: { displayName: context.config.displayName },
      });
      return result("Human-intervention request sent.", { messageId: id });
    }

    throw new Error(`Unknown tool: ${params.name}`);
  } catch (error) {
    if (context) {
      await context.bridge.log.write("tool_failed", { tool: params.name, error: error.message });
    }
    return failure(error);
  }
});

await refreshConfig();
const transport = new StdioServerTransport();
await mcp.connect(transport);
mcpReady = true;
void activeContext.bridge.start();

const reloadTimer = setInterval(() => {
  void refreshConfig().catch((error) => {
    lastReloadError = error.message;
  });
}, 500);
reloadTimer.unref();

async function shutdown() {
  clearInterval(reloadTimer);
  await activeContext?.bridge.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
