import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokerEndpoint } from "./broker-endpoint.js";
import { JsonlLogger } from "./logger.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxLocalFrameBytes = Number(process.env.AGENT_LINK_MAX_LOCAL_FRAME_BYTES || 512 * 1024);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workspaceFingerprint() {
  return process.env.AGENT_LINK_WORKSPACE || process.cwd();
}

export class BrokerClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.endpoint = brokerEndpoint(config.configPath);
    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.closed = false;
    this.buffer = "";
    this.pending = new Map();
    this.frontend = {
      frontendId: randomUUID(),
      taskId: process.env.AGENT_LINK_TASK_ID || `${process.env.AGENT_LINK_CLIENT_TYPE || "mcp"}-${process.pid}`,
      clientType: process.env.AGENT_LINK_CLIENT_TYPE || "generic-mcp",
      workspaceFingerprint: workspaceFingerprint(),
      tags: (process.env.AGENT_LINK_TAGS || "").split(",").map((item) => item.trim()).filter(Boolean),
      wakeMode: process.env.AGENT_LINK_WAKE_MODE || "blocking_tool",
      activityCancel: process.env.AGENT_LINK_ACTIVITY_CANCEL === "1",
    };
    const safeAgent = config.agentId.replace(/[^A-Za-z0-9_-]/g, "_");
    this.log = new JsonlLogger(
      path.join(config.logDir, `${config.roomId}-${safeAgent}-frontend-${process.pid}.jsonl`),
      { component: "frontend", roomId: config.roomId, agentId: config.agentId },
      { sensitiveKey: config.identity.privateKey },
    );
  }

  async connect() {
    if (this.connected && !this.socket?.destroyed) return;
    if (this.connecting) return this.connecting;
    this.closed = false;
    this.connecting = this.#connectWithBrokerStart();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async start() {
    return this.connect();
  }

  async #connectSocket() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        this.socket = socket;
        this.buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => this.#onData(chunk));
        socket.on("error", (error) => this.log.write("broker_socket_error", { error: error.message }));
        socket.on("close", () => this.#onClose());
        this.connected = true;
        resolve();
      });
    });
  }

  #startBroker() {
    const child = spawn(
      process.execPath,
      [path.join(rootDir, "src", "broker-server.js"), this.config.configPath],
      {
        cwd: rootDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      },
    );
    child.unref();
  }

  async #connectWithBrokerStart() {
    try {
      await this.#connectSocket();
    } catch {
      this.#startBroker();
      let lastError;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(Math.min(250, 25 + attempt * 10));
        try {
          await this.#connectSocket();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    }
    const proof = createHmac("sha256", this.config.secret)
      .update(`agent-link-local-broker-v1:${this.frontend.frontendId}`)
      .digest("base64url");
    await this.call("register", { frontend: this.frontend, proof }, {
      timeoutMs: 5_000,
      skipConnect: true,
    });
    await this.log.write("broker_connected", { endpoint: this.endpoint, frontend: this.frontend });
  }

  #onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > maxLocalFrameBytes) {
      this.socket?.destroy(new Error("Local broker frame is too large"));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "event") {
        this.emit(message.event, message.data);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Local broker request failed"));
    }
  }

  #onClose() {
    this.connected = false;
    this.socket = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Local AgentLink broker disconnected"));
      this.pending.delete(id);
    }
    this.emit("disconnected");
  }

  async call(method, params = {}, { timeoutMs = 10_000, skipConnect = false } = {}) {
    if (!skipConnect) await this.connect();
    if (!this.socket || this.socket.destroyed) throw new Error("Local AgentLink broker is unavailable");
    const id = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Local broker ${method} timed out`));
        }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  async remoteStatus() {
    return this.call("status");
  }

  async send(text, options = {}) {
    const result = await this.call("send", { text, ...options });
    return result.messageId;
  }

  wait({ kinds, predicate, timeoutMs = 0 } = {}) {
    const replyTo = predicate?.replyTo || null;
    return this.call("wait", { kinds, replyTo, timeoutMs }, { timeoutMs: timeoutMs ? timeoutMs + 5_000 : 0 });
  }

  async exchange(text, options = {}) {
    if (text) await this.send(text, options);
    return this.call("wait", {
      kinds: options.responseKinds || ["chat"],
      timeoutMs: options.timeoutMs || 0,
    }, { timeoutMs: options.timeoutMs ? options.timeoutMs + 5_000 : 0 });
  }

  ask(question, options = {}) {
    return this.call("ask", { question, ...options }, {
      timeoutMs: options.timeoutMs ? options.timeoutMs + 5_000 : 0,
    });
  }

  requestSend(question, options = {}) {
    return this.call("request_send", { question, ...options });
  }

  requestStatus(options = {}) {
    return this.call("request_status", options, {
      timeoutMs: options.waitMs ? options.waitMs + 5_000 : 10_000,
    });
  }

  respond(requestId, text, metadata = {}) {
    return this.call("respond", { requestId, text, metadata });
  }

  markProcessing(requestId) {
    return this.call("mark_processing", { requestId });
  }

  listInbox() {
    return this.call("inbox_list");
  }

  claimInbox(requestId) {
    return this.call("inbox_claim", { requestId });
  }

  watch(timeoutMs = 0) {
    return this.call("watch", { timeoutMs }, { timeoutMs: timeoutMs ? timeoutMs + 5_000 : 0 });
  }

  release(requestId) {
    return this.call("release", { requestId });
  }

  discard(messageId) {
    return this.call("discard", { messageId });
  }

  status() {
    return {
      connected: this.connected,
      brokerEndpoint: this.endpoint,
      frontend: this.frontend,
    };
  }

  async close() {
    this.closed = true;
    this.socket?.end();
    this.socket?.destroy();
    this.connected = false;
    await this.log.write("broker_frontend_closed");
    await this.log.flush();
  }
}
