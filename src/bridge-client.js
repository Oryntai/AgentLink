import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import {
  decryptPayload,
  encryptPayload,
  identityProof,
  messageId,
  roomAuth,
  signEnvelope,
  verifyIdentityProof,
  verifyEnvelope,
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
    this.superseded = false;
    this.connecting = null;
    this.inbox = [];
    this.waiters = [];
    this.ackWaiters = new Map();
    this.seen = new Set();
    this.peerOnline = false;
    this.peerKeys = new Map();
    this.trustFile = `${config.configPath}.trust.json`;
    this.trustSaveChain = Promise.resolve();
    this.trustReady = this.#loadTrust();
    this.reconnectAttempt = 0;
    const safeAgent = config.agentId.replace(/[^A-Za-z0-9_-]/g, "_");
    this.log = new JsonlLogger(
      path.join(config.logDir, `${config.roomId}-${safeAgent}-${process.pid}.jsonl`),
      {
        component: "bridge",
        roomId: config.roomId,
        agentId: config.agentId,
        displayName: config.displayName,
        role: config.role,
      },
      { sensitiveKey: config.identity.privateKey },
    );
  }

  async connect() {
    await this.trustReady;
    if (this.superseded) {
      throw new Error("This AgentLink MCP instance was superseded by a newer local task");
    }
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
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("error", fail);
        ws.off("close", onHandshakeClose);
        ws.off("message", onWelcome);
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const onHandshakeClose = (code, reason) => {
        fail(new Error(`Relay rejected connection (${code}): ${reason.toString() || "closed"}`));
      };
      const timer = setTimeout(() => {
        fail(new Error("Relay connection timed out"));
        ws.terminate();
      }, 10_000);
      ws.once("error", fail);
      ws.once("close", onHandshakeClose);
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            roomId: this.config.roomId,
            auth: roomAuth(this.config.roomId, this.config.secret),
            agentId: this.config.agentId,
            role: this.config.role,
            publicKey: this.config.identity.publicKey,
            keyProof: identityProof(
              this.config.roomId,
              this.config.secret,
              this.config.agentId,
              this.config.identity.publicKey,
            ),
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
          try {
            for (const peer of message.peers || []) {
              if (typeof peer === "object") {
                this.#pinPeer(peer.agentId, peer.publicKey, peer.keyProof);
              }
            }
          } catch (error) {
            cleanup();
            ws.close(4010, "peer identity mismatch");
            reject(error);
            return;
          }
          cleanup();
          this.online = true;
          this.peerOnline = Boolean(message.peers?.length);
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
      try {
        if (message.publicKey) {
          this.#pinPeer(message.agentId, message.publicKey, message.keyProof);
        }
      } catch (error) {
        this.log.write("peer_identity_mismatch", {
          peerId: message.agentId,
          error: error.message,
        });
        this.ws?.close(4010, "peer identity mismatch");
        return;
      }
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

    if (message.type === "message_accepted") {
      const waiter = this.ackWaiters.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.ackWaiters.delete(message.id);
        waiter.resolve();
      }
      return;
    }

    if (message.type === "error") {
      const waiter = message.id ? this.ackWaiters.get(message.id) : null;
      if (waiter) {
        clearTimeout(waiter.timer);
        this.ackWaiters.delete(message.id);
        waiter.reject(new Error(message.error || "Relay rejected message"));
      }
      this.log.write("relay_rejected", { messageId: message.id, error: message.error });
      return;
    }

    if (message.type !== "message") return;
    const { envelope } = message;
    if (
      !envelope?.id ||
      envelope.version !== 2 ||
      envelope.roomId !== this.config.roomId ||
      (envelope.to && envelope.to !== this.config.agentId)
    ) {
      this.log.write("invalid_envelope", { messageId: envelope?.id });
      return;
    }
    if (this.seen.has(envelope.id)) {
      this.#sendRaw({ type: "message_ack", id: envelope.id });
      return;
    }
    try {
      const peerKey = this.peerKeys.get(envelope.from);
      if (!peerKey || !verifyEnvelope(peerKey, envelope)) {
        this.log.write("invalid_message_signature", {
          messageId: envelope.id,
          from: envelope.from,
        });
        this.#sendRaw({ type: "message_ack", id: envelope.id });
        return;
      }
      const payload = decryptPayload(
        this.config.roomId,
        this.config.secret,
        envelope.encrypted,
        envelope,
      );
      this.seen.add(envelope.id);
      while (this.seen.size > 5_000) this.seen.delete(this.seen.values().next().value);
      void this.#queueTrustSave().catch((error) =>
        this.log.write("replay_cache_save_failed", { error: error.message }),
      );
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
    for (const [id, waiter] of this.ackWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Relay disconnected before accepting message ${id}`));
      this.ackWaiters.delete(id);
    }
    if (code === 4006) {
      this.superseded = true;
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("AgentLink ownership moved to a newer local task"));
      }
      this.log.write("bridge_superseded");
      return;
    }
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
      version: 2,
      id,
      roomId: this.config.roomId,
      from: this.config.agentId,
      to: to || this.config.peerId || null,
      sentAt: new Date().toISOString(),
    };
    envelope.encrypted = encryptPayload(
      this.config.roomId,
      this.config.secret,
      payload,
      envelope,
    );
    envelope.signature = signEnvelope(this.config.identity.privateKey, envelope);
    const accepted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(id);
        reject(new Error("Relay did not accept the message within 5 seconds"));
      }, 5_000);
      this.ackWaiters.set(id, { resolve, reject, timer });
    });
    try {
      this.#sendRaw({ type: "message", envelope });
    } catch (error) {
      const waiter = this.ackWaiters.get(id);
      if (waiter) clearTimeout(waiter.timer);
      this.ackWaiters.delete(id);
      throw error;
    }
    await accepted;
    await this.log.write("message_sent", {
      messageId: id,
      to: envelope.to,
      kind,
      text,
      metadata,
    });
    return id;
  }

  wait({ kinds, predicate, timeoutMs = 0 } = {}) {
    const kindSet = kinds ? new Set(kinds) : null;
    const matches = (message) =>
      (!kindSet || kindSet.has(message.kind)) && (!predicate || predicate(message));
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
    return this.wait({ kinds: options.responseKinds || ["chat"], timeoutMs: options.timeoutMs });
  }

  status() {
    return {
      connected: this.online,
      superseded: this.superseded,
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

  async #loadTrust() {
    try {
      const stored = JSON.parse(await readFile(this.trustFile, "utf8"));
      for (const [agentId, publicKey] of Object.entries(stored.peers || {})) {
        this.peerKeys.set(agentId, publicKey);
      }
      for (const messageId of stored.seenMessageIds || []) this.seen.add(messageId);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  #pinPeer(agentId, publicKey, keyProof) {
    if (!agentId || !publicKey || agentId === this.config.agentId) return;
    if (!verifyIdentityProof(
      this.config.roomId,
      this.config.secret,
      agentId,
      publicKey,
      keyProof,
    )) {
      throw new Error(`Invalid room proof for ${agentId}`);
    }
    const existing = this.peerKeys.get(agentId);
    if (existing && existing !== publicKey) {
      throw new Error(`Pinned public key changed for ${agentId}`);
    }
    if (!existing) {
      this.peerKeys.set(agentId, publicKey);
      void this.#queueTrustSave().catch((error) =>
        this.log.write("trust_save_failed", { error: error.message }),
      );
    }
  }

  async #saveTrust() {
    await mkdir(path.dirname(this.trustFile), { recursive: true });
    const tmp = `${this.trustFile}.tmp`;
    await writeFile(
      tmp,
      `${JSON.stringify({
        peers: Object.fromEntries(this.peerKeys),
        seenMessageIds: [...this.seen],
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(tmp, this.trustFile);
  }

  #queueTrustSave() {
    this.trustSaveChain = this.trustSaveChain.catch(() => {}).then(() => this.#saveTrust());
    return this.trustSaveChain;
  }

  async close() {
    this.closed = true;
    this.online = false;
    this.ws?.close(1000, "client shutdown");
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Bridge closed"));
    }
    for (const [id, waiter] of this.ackWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Bridge closed"));
      this.ackWaiters.delete(id);
    }
    await this.log.write("bridge_closed");
    await this.trustSaveChain.catch(() => {});
    await this.log.flush();
  }
}
