import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokerEndpoint } from "./broker-endpoint.js";
import { loadBridgeConfig } from "./config.js";
import { JsonlLogger } from "./logger.js";
import {
  BROKER_PROTOCOL_VERSION,
  CORE_BROKER_METHODS,
  brokerCompatibility,
} from "./protocol-version.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxLocalFrameBytes = Number(process.env.AGENT_LINK_MAX_LOCAL_FRAME_BYTES || 512 * 1024);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workspaceFingerprint() {
  return process.env.AGENT_LINK_WORKSPACE || process.cwd();
}

export class BrokerClient extends EventEmitter {
  constructor(config, {
    requiredMethods = CORE_BROKER_METHODS,
    clientType = process.env.AGENT_LINK_CLIENT_TYPE || "generic-mcp",
  } = {}) {
    super();
    this.config = config;
    // Required methods are a frontend capability, not a global constant: a
    // desktop client needs more of the broker than a generic MCP session does.
    this.requiredMethods = requiredMethods;
    this.endpoint = brokerEndpoint(config.configPath);
    this.socket = null;
    this.connected = false;
    this.connecting = null;
    this.closed = false;
    this.buffer = "";
    this.pending = new Map();
    this.broker = null;
    this.frontend = {
      frontendId: randomUUID(),
      taskId: process.env.AGENT_LINK_TASK_ID || `${clientType}-${process.pid}`,
      clientType,
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
    } catch (error) {
      // A half-open link must never look connected, or the next connect() would
      // short-circuit and keep talking to the broker we just rejected.
      this.socket?.destroy();
      this.socket = null;
      this.connected = false;
      this.broker = null;
      this.buffer = "";
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  // Fire-and-forget entry point: a momentarily missing broker must not become an
  // unhandled rejection that kills the MCP session. Later calls reconnect.
  async start() {
    try {
      await this.connect();
    } catch (error) {
      await this.log.write("broker_start_failed", { error: error.message });
    }
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

  async #ensureSocket() {
    try {
      await this.#connectSocket();
      return;
    } catch {
      // No broker is listening yet, so this frontend starts one.
    }
    let lastError;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (attempt % 15 === 0) this.#startBroker();
      await delay(Math.min(250, 25 + attempt * 10));
      try {
        await this.#connectSocket();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Local AgentLink broker did not start");
  }

  #localProof(value) {
    return createHmac("sha256", this.config.secret)
      .update(`agent-link-local-broker-v1:${value}`)
      .digest("base64url");
  }

  async #hello(attempts = 3) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.call(
          "hello",
          { clientProtocol: BROKER_PROTOCOL_VERSION },
          {
            timeoutMs: Number(process.env.AGENT_LINK_HELLO_TIMEOUT_MS || 5_000),
            skipConnect: true,
          },
        );
      } catch (error) {
        // Only a rejection from the broker itself proves it predates hello.
        // Silence under load must not be mistaken for an incompatible broker.
        if (error.remote) return null;
        if (!this.socket || this.socket.destroyed) throw error;
        if (attempt >= attempts) throw error;
        await delay(100 * attempt);
      }
    }
  }

  #awaitSocketClose(timeoutMs) {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async #replaceBroker(info, reason) {
    // Authenticated takeover is the only automatic path. Killing a pid read from
    // a file cannot prove the process is still the broker that wrote it.
    if (!(info?.methods || []).includes("takeover")) return false;
    const closed = this.#awaitSocketClose(10_000);
    try {
      await this.call(
        "takeover",
        {
          frontendId: this.frontend.frontendId,
          proof: this.#localProof(this.frontend.frontendId),
          reason,
        },
        { timeoutMs: 5_000, skipConnect: true },
      );
    } catch (error) {
      await this.log.write("broker_takeover_failed", { error: error.message });
      return false;
    }
    await closed;
    this.socket?.destroy();
    this.connected = false;
    await this.log.write("broker_replaced", { reason });
    return true;
  }

  async #connectWithBrokerStart(attempts = 3) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#negotiateAndRegister();
        return;
      } catch (error) {
        // A broker that exits between our connect and our handshake is not a
        // failure to report, it is a broker to start again.
        const transportLost = !error.remote && (!this.socket || this.socket.destroyed);
        if (!transportLost || attempt >= attempts) throw error;
        await this.log.write("broker_handshake_retry", { attempt, error: error.message });
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;
        this.buffer = "";
        await delay(50 * attempt);
      }
    }
  }

  async #negotiateAndRegister() {
    await this.#ensureSocket();
    let info = await this.#hello();
    let compatibility = brokerCompatibility(info, { requiredMethods: this.requiredMethods });
    if (!compatibility.compatible) {
      const replaced = await this.#replaceBroker(info, compatibility.reason);
      if (!replaced) {
        throw new Error(
          `Local AgentLink broker is incompatible (${compatibility.reason}) and does not support handover. `
          + `Stop it with: npm run stop-broker -- --config ${this.config.configPath}`,
        );
      }
      await this.#ensureSocket();
      info = await this.#hello();
      compatibility = brokerCompatibility(info, { requiredMethods: this.requiredMethods });
      if (!compatibility.compatible) {
        throw new Error(
          `Local AgentLink broker is still incompatible after replacement (${compatibility.reason}); `
          + `this build needs broker protocol ${compatibility.required}.`,
        );
      }
    }
    this.broker = info;
    await this.call(
      "register",
      { frontend: this.frontend, proof: this.#localProof(this.frontend.frontendId) },
      { timeoutMs: 5_000, skipConnect: true },
    );
    await this.log.write("broker_connected", {
      endpoint: this.endpoint,
      frontend: this.frontend,
      brokerProtocol: info.brokerProtocol,
      brokerPid: info.pid,
    });
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
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        const error = new Error(message.error || "Local broker request failed");
        // The broker answered. Callers use this to tell a real rejection apart
        // from silence, which must never be read as a verdict about the broker.
        error.remote = true;
        pending.reject(error);
      }
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

  // A room change rotates the room secret, so the broker drops every frontend's
  // authentication: the proof they registered with no longer means anything.
  // Reload the config from disk and register again with the new secret.
  async #reauthenticate() {
    this.config = await loadBridgeConfig(this.config.configPath);
    await this.call(
      "register",
      { frontend: this.frontend, proof: this.#localProof(this.frontend.frontendId) },
      { timeoutMs: 5_000, skipConnect: true, noRetry: true },
    );
    await this.log.write("broker_reauthenticated", { roomId: this.config.roomId });
  }

  async call(method, params = {}, options = {}) {
    const { timeoutMs = 10_000, skipConnect = false, noRetry = false } = options;
    if (!skipConnect) await this.connect();
    if (!noRetry) {
      try {
        return await this.#send(method, params, { timeoutMs });
      } catch (error) {
        if (!error.remote || !/must register/i.test(error.message)) throw error;
        await this.#reauthenticate();
        return this.#send(method, params, { timeoutMs });
      }
    }
    return this.#send(method, params, { timeoutMs });
  }

  async #send(method, params, { timeoutMs }) {
    if (!this.socket || this.socket.destroyed) throw new Error("Local AgentLink broker is unavailable");
    const id = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          const error = new Error(`Local broker ${method} timed out`);
          error.timeout = true;
          reject(error);
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

  ownerRequestSend(question, options = {}) {
    return this.call("owner_request_send", { question, ...options });
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

  activityTail(limit = 100) {
    return this.call("activity_tail", { limit });
  }

  createRoom(name) {
    return this.call("room_create", { name }, { timeoutMs: 20_000 });
  }

  joinRoom(invite) {
    return this.call("room_join", { invite }, { timeoutMs: 20_000 });
  }

  createInvite(options = {}) {
    return this.call("invite_create", options, { timeoutMs: 20_000 });
  }

  listInvites() {
    return this.call("invite_list");
  }

  revokeInvite(inviteId) {
    return this.call("invite_revoke", { inviteId });
  }

  verifyPeer(fingerprint) {
    return this.call("peer_verify", { fingerprint });
  }

  getPolicy() {
    return this.call("policy_get");
  }

  setPolicy(approvals) {
    return this.call("policy_set", { approvals });
  }

  listApprovals() {
    return this.call("approval_list");
  }

  decideApproval(requestId, decision, reason = null) {
    return this.call("approval_decide", { requestId, decision, reason });
  }

  listConversations() {
    return this.call("conversation_list");
  }

  listTranscript(options = {}) {
    return this.call("transcript_list", options);
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
      broker: this.broker,
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
