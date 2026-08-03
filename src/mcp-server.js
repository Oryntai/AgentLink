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

const config = await loadBridgeConfig(process.argv[2]);
const stateFile = `${config.configPath}.state.json`;
let state = await loadState();
let mcpReady = false;

async function loadState() {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { phase: "negotiating_goal", goal: null, successCriteria: [] };
  }
}

async function saveState(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  await mkdir(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, stateFile);
}

function naturalMessage(message) {
  const sender = message.metadata?.displayName || message.from;
  const labels = {
    chat: `Сообщение от агента ${sender}`,
    goal_proposal: `Предложение конечной цели от агента ${sender}`,
    goal_accept: `Агент ${sender} подтвердил цель`,
    goal_reject: `Агент ${sender} отклонил цель`,
    finish_proposal: `Агент ${sender} предлагает завершить разговор`,
    finish_accept: `Агент ${sender} подтвердил завершение`,
    finish_reject: `Агент ${sender} отказался завершать разговор`,
    escalation: `Агент ${sender} просит вмешательства человека`,
  };
  return `${labels[message.kind] || `Событие от агента ${sender}`}:\n${message.text}`;
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

const mcp = new Server(
  { name: "agent-link", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "AgentLink connects this agent to one trusted peer agent. Messages are ordinary natural language. " +
      "Before discussing work, establish and mutually accept one concrete conversation goal with peer_goal. " +
      "For Codex-style blocking work, use peer_exchange: it sends a message and remains pending until the peer replies. " +
      "For Claude channel mode, inbound messages arrive automatically as <channel> events; reply with peer_reply. " +
      "The peer never receives direct access to local files, terminal, database, secrets, or tools. Read local context yourself, " +
      "then send only the minimum textual answer. Never disclose credentials, tokens, .env contents, or unnecessary personal data. " +
      "When the agreed goal is reached, use peer_complete and stop the conversation after mutual confirmation.",
  },
);

const bridge = new BridgeClient(config);

bridge.on("message", async (message) => {
  if (message.kind === "goal_proposal") {
    await saveState({
      phase: "goal_proposed_by_peer",
      goal: message.text,
      successCriteria: message.metadata?.successCriteria || [],
    });
  } else if (message.kind === "goal_accept") {
    await saveState({ phase: "active", peerGoalAccepted: true });
  } else if (message.kind === "goal_reject") {
    await saveState({ phase: "negotiating_goal", peerGoalAccepted: false });
  } else if (message.kind === "finish_proposal") {
    await saveState({ phase: "finish_proposed_by_peer", finishSummary: message.text });
  } else if (message.kind === "finish_accept") {
    await saveState({ phase: "finished", peerFinishAccepted: true });
    await bridge.close();
  } else if (message.kind === "finish_reject") {
    await saveState({ phase: "active", peerFinishAccepted: false });
  }

  if (config.channelMode && mcpReady) {
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: naturalMessage(message),
          meta: {
            room_id: config.roomId,
            sender_id: message.from,
            message_id: message.id,
            kind: message.kind,
          },
        },
      });
      bridge.discard(message.id);
    } catch (error) {
      await bridge.log.write("channel_push_failed", { error: error.message });
    }
  }
});

const tools = [
  {
    name: "peer_status",
    description: "Show the encrypted peer session state, connection status, role, phase, and local log path.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "peer_goal",
    description:
      "Negotiate the mandatory final goal of this conversation. Initiator uses propose; responder uses wait then accept/reject.",
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
      "Radio-style exchange for Codex: optionally send one natural-language message, then remain suspended until the peer replies. No model tokens are generated while the tool is pending.",
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
    description:
      "Send a natural-language reply without waiting. Use this for Claude channel events, which can wake the session again when the peer responds.",
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
      "Mutually finish the conversation once its accepted goal and success criteria are satisfied.",
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
  const timeoutMs = Number(args.timeout_seconds || 3600) * 1000;
  await bridge.log.write("tool_called", { tool: params.name, arguments: args });
  try {
    if (params.name === "peer_status" && state.phase === "finished") {
      return result(JSON.stringify({ ...bridge.status(), session: state }, null, 2), {
        ...bridge.status(),
        session: state,
      });
    }
    await bridge.connect();
    if (params.name === "peer_status") {
      return result(JSON.stringify({ ...bridge.status(), session: state }, null, 2), {
        ...bridge.status(),
        session: state,
      });
    }

    if (params.name === "peer_goal") {
      if (args.action === "propose") {
        if (config.role !== "initiator") throw new Error("Only the initiator may propose the first goal");
        if (!args.goal?.trim()) throw new Error("goal is required");
        const criteria = args.success_criteria || [];
        await saveState({
          phase: "goal_proposed",
          goal: args.goal.trim(),
          successCriteria: criteria,
        });
        await bridge.send(args.goal.trim(), {
          kind: "goal_proposal",
          metadata: { displayName: config.displayName, successCriteria: criteria },
        });
        const reply = await bridge.wait({
          kinds: ["goal_accept", "goal_reject"],
          timeoutMs,
        });
        return result(naturalMessage(reply), { message: reply, session: state });
      }
      if (args.action === "wait") {
        const proposal = await bridge.wait({ kinds: ["goal_proposal"], timeoutMs });
        return result(naturalMessage(proposal), { message: proposal, session: state });
      }
      if (!["goal_proposed_by_peer", "negotiating_goal"].includes(state.phase)) {
        throw new Error(`Cannot ${args.action} goal while phase is ${state.phase}`);
      }
      const accepted = args.action === "accept";
      await bridge.send(args.note || (accepted ? "Цель подтверждена." : "Цель требует уточнения."), {
        kind: accepted ? "goal_accept" : "goal_reject",
        metadata: { displayName: config.displayName },
      });
      await saveState({ phase: accepted ? "active" : "negotiating_goal", localGoalAccepted: accepted });
      return result(accepted ? "Цель подтверждена. Можно начинать разговор." : "Отказ отправлен. Ожидайте новую формулировку цели.", { session: state });
    }

    if (params.name === "peer_exchange") {
      if (state.phase !== "active") throw new Error(`Conversation is not active; current phase is ${state.phase}`);
      const incoming = await bridge.exchange(args.message?.trim(), {
        kind: "chat",
        metadata: { displayName: config.displayName },
        timeoutMs,
      });
      return result(naturalMessage(incoming), { message: incoming });
    }

    if (params.name === "peer_reply") {
      if (state.phase !== "active" && state.phase !== "finish_proposed_by_peer") {
        throw new Error(`Conversation is not active; current phase is ${state.phase}`);
      }
      const id = await bridge.send(args.message.trim(), {
        kind: "chat",
        metadata: { displayName: config.displayName },
      });
      return result("Ответ отправлен агенту. Сессия может перейти в background и дождаться следующего channel-события.", { messageId: id });
    }

    if (params.name === "peer_complete") {
      if (args.action === "propose") {
        if (state.phase !== "active") throw new Error(`Cannot finish while phase is ${state.phase}`);
        if (!args.summary?.trim()) throw new Error("summary is required");
        await saveState({ phase: "finish_proposed", finishSummary: args.summary.trim() });
        await bridge.send(args.summary.trim(), {
          kind: "finish_proposal",
          metadata: { displayName: config.displayName },
        });
        const reply = await bridge.wait({
          kinds: ["finish_accept", "finish_reject"],
          timeoutMs,
        });
        return result(naturalMessage(reply), { message: reply, session: state });
      }
      if (state.phase !== "finish_proposed_by_peer") {
        throw new Error(`No peer finish proposal is pending; current phase is ${state.phase}`);
      }
      const accepted = args.action === "accept";
      await bridge.send(args.note || (accepted ? "Завершение подтверждено." : "Цель ещё не достигнута."), {
        kind: accepted ? "finish_accept" : "finish_reject",
        metadata: { displayName: config.displayName },
      });
      await saveState({ phase: accepted ? "finished" : "active", localFinishAccepted: accepted });
      if (accepted) await bridge.close();
      return result(accepted ? "Разговор завершён по взаимному согласию." : "Продолжение разговора подтверждено.", { session: state });
    }

    if (params.name === "peer_escalate") {
      const id = await bridge.send(args.question.trim(), {
        kind: "escalation",
        metadata: { displayName: config.displayName },
      });
      return result("Запрос вмешательства отправлен.", { messageId: id });
    }

    throw new Error(`Unknown tool: ${params.name}`);
  } catch (error) {
    await bridge.log.write("tool_failed", { tool: params.name, error: error.message });
    return failure(error);
  }
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
mcpReady = true;
if (config.channelMode) void bridge.start();

process.on("SIGINT", async () => {
  await bridge.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await bridge.close();
  process.exit(0);
});
