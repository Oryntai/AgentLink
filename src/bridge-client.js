import { EventEmitter } from "node:events";
import path from "node:path";
import { WebSocket } from "ws";
import {
  decryptPayload,
  encryptPayload,
  messageId,
  roomAuth,
} from "./crypto.js";
import { JsonlLogger } from "./logger.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BridgeClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.ws = null;
    this.online = false;
    this.closed = false;
    this.connecting = null;
    this.inbox = [];
    this.waiters = [];
    this.seen = new Set();
    this.peerOnline = false;
    this.reconnectAttempt = 0;
    const safeAgent = config.agentId.replace(/[^A-Za-z0-9_-]/g, "_");
    this.log = new JsonlLogger(
      path.join(config.logDir, `${config.roomId}-${safeAgent}.jsonl`),
      {
        component: "bridge",
        roomId: config.roomId,
        agentId: config.agentId,
        displayName: config.displayName,
        role: config.role,
      },
    );
  }

  async connect() {
    if (this.online && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.closed = false;
    this.connecting = this.#open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async start() {
    try {
      await this.connect();
    } catch (error) {
      await this.log.write("initial_connect_failed", { error: error.message });
      if (!this.closed) this.#scheduleReconnect();
    }
  }

  async #open() {
    await this.log.write("relay_connecting", { relayUrl: this.config.relayUrl });
    const ws = new WebSocket(this.config.relayUrl);
    this.ws = ws;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Relay connection timed out")), 10_000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      ws.once("error", fail);
      ws.once("open", () => {
        ws.off("error", fail);
        ws.send(
          JSON.stringify({
            type: "hello",
            roomId: this.config.roomId,
            auth: roomAuth(this.config.roomId, this.config.secret),
            agentId: this.config.agentId,
            role: this.config.role,
          }),
        );
      });
      const onWelcome = (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (message.type === "welcome") {
          clearTimeout(timer);
          ws.off("message", onWelcome);
          this.online = true;
          this.reconnectAttempt = 0;
          this.log.write("relay_connected", { peers: message.peers || [] });
          this.emit("connected", message);
          resolve();
        }
      };
      ws.on("message", onWelcome);
    });

    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("close", (code, reason) => this.#onClose(code, reason.toString()));
    ws.on("error", (error) => this.log.write("relay_error", { error: error.message }));
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      this.log.write("invalid_relay_message", { error: error.message });
      return;
    }

    if (message.type === "peer_status") {
      this.peerOnline = Boolean(message.online);
      this.log.write("peer_status", {
        peerId: message.agentId,
        online: this.peerOnline,
      });
      this.emit("peer_status", message);
      return;
    }

    if (message.type === "delivery_ack") {
      this.log.write("outbound_delivered", {
        messageId: message.id,
        recipient: message.recipient,
      });
      return;
    }

    if (message.type !== "message") return;
    const { envelope } = message;
    if (this.seen.has(envelope.id)) {
      this.#sendRaw({ type: "message_ack", id: envelope.id });
      return;
    }
    try {
      const payload = decryptPayload(
        this.config.roomId,
        this.config.secret,
        envelope.encrypted,
      );
      this.seen.add(envelope.id);
      const received = {
        id: envelope.id,
        from: envelope.from,
        sentAt: envelope.sentAt,
        receivedAt: new Date().toISOString(),
        ...payload,
      };
      this.log.write("message_received", {
        messageId: received.id,
        from: received.from,
        kind: received.kind,
        text: received.text,
        metadata: received.metadata,
      });
      this.#sendRaw({ type: "message_ack", id: envelope.id });
      this.#deliver(received);
      this.emit("message", received);
    } catch (error) {
      this.log.write("decrypt_failed", {
        messageId: envelope.id,
        error: error.message,
      });
    }
  }

  #deliver(message) {
    const index = this.waiters.findIndex((waiter) => waiter.matches(message));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.inbox.push(message);
  }

  #onClose(code, reason) {
    this.online = false;
    this.log.write("relay_disconnected", { code, reason });
    this.emit("disconnected", { code, reason });
    if (!this.closed) this.#scheduleReconnect();
  }

  async #scheduleReconnect() {
    this.reconnectAttempt += 1;
    const waitMs = Math.min(10_000, 500 * 2 ** Math.min(this.reconnectAttempt, 5));
    await delay(waitMs);
    if (this.closed || this.online || this.connecting) return;
    try {
      await this.connect();
    } catch (error) {
      await this.log.write("reconnect_failed", { error: error.message });
      if (!this.closed) this.#scheduleReconnect();
    }
  }

  #sendRaw(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("Relay is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  async send(text, { kind = "chat", metadata = {}, to = null } = {}) {
    await this.connect();
    const id = messageId();
    const payload = { kind, text, metadata };
    const envelope = {
      id,
      roomId: this.config.roomId,
      from: this.config.agentId,
      to: to || this.config.peerId || null,
      sentAt: new Date().toISOString(),
      encrypted: encryptPayload(this.config.roomId, this.config.secret, payload),
    };
    this.#sendRaw({ type: "message", envelope });
    await this.log.write("message_sent", {
      messageId: id,
      to: envelope.to,
      kind,
      text,
      metadata,
    });
    return id;
  }

  wait({ kinds, timeoutMs = 0 } = {}) {
    const kindSet = kinds ? new Set(kinds) : null;
    const matches = (message) => !kindSet || kindSet.has(message.kind);
    const index = this.inbox.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);

    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const position = this.waiters.indexOf(waiter);
          if (position >= 0) this.waiters.splice(position, 1);
          reject(new Error(`No peer message within ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  async exchange(text, options = {}) {
    if (text) await this.send(text, options);
    return this.wait({ timeoutMs: options.timeoutMs });
  }

  status() {
    return {
      connected: this.online,
      peerOnline: this.peerOnline,
      roomId: this.config.roomId,
      agentId: this.config.agentId,
      displayName: this.config.displayName,
      role: this.config.role,
      queuedMessages: this.inbox.length,
      logFile: this.log.filePath,
    };
  }

  discard(messageId) {
    const index = this.inbox.findIndex((message) => message.id === messageId);
    if (index >= 0) this.inbox.splice(index, 1);
  }

  async close() {
    this.closed = true;
    this.online = false;
    this.ws?.close(1000, "client shutdown");
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Bridge closed"));
    }
    await this.log.write("bridge_closed");
    await this.log.flush();
  }
}
