import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { withFileLock, writeFileAtomic } from "./atomic-file.js";
import {
  decryptPayload,
  encryptPayload,
  identityProof,
  inviteProof,
  messageId,
  publicKeyFingerprint,
  roomAuth,
  signEnvelope,
  verifyIdentityProof,
  verifyInviteProof,
  verifyEnvelope,
} from "./crypto.js";
import { openInviteRegistry } from "./invite-registry.js";
import { mergeTrust, sanitizeTrust } from "./trust-store.js";
import { JsonlLogger } from "./logger.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BridgeClient extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.manualAck = Boolean(options.manualAck);
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
    this.boundPeer = null;
    // Room scoped: a rotated room must be able to admit a different key under
    // the same agent id without the previous room's binding standing in the way.
    this.trustFile = `${config.configPath}.${config.roomId}.trust.json`;
    this.legacyTrustFile = `${config.configPath}.trust.json`;
    this.trustSaveChain = Promise.resolve();
    this.trustReady = this.#loadTrust();
    this.inviteRegistry = options.inviteRegistry || null;
    this.registrySaveChain = Promise.resolve();
    this.inboundChain = Promise.resolve();
    // Handled here rather than at first use: a floating rejection from this
    // constructor would take the whole MCP process down.
    this.inviteReady = (this.inviteRegistry
      ? Promise.resolve(this.inviteRegistry)
      : openInviteRegistry(config.configPath).then((registry) => {
        this.inviteRegistry = registry;
        return registry;
      })
    ).catch((error) => {
      this.inviteRegistry = null;
      this.inviteLoadError = error.message;
      return null;
    });
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
    await this.inviteReady;
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
            ...(this.config.inviteId
              ? {
                inviteId: this.config.inviteId,
                inviteProof: inviteProof(
                  this.config.roomId,
                  this.config.secret,
                  this.config.inviteId,
                  this.config.agentId,
                  this.config.identity.publicKey,
                ),
              }
              : {}),
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
        if (message.type !== "welcome") return;
        // Admission is queued on the same chain as inbound frames, so a peer is
        // never accepted before its invite is durably recorded and no frame is
        // handled before the peer that sent it is pinned.
        this.inboundChain = this.inboundChain.then(async () => {
          try {
            for (const peer of message.peers || []) {
              if (typeof peer === "object") {
                await this.#pinPeer(peer.agentId, peer.publicKey, peer.keyProof, peer);
              }
            }
          } catch (error) {
            cleanup();
            ws.close(4010, "peer not admitted");
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
        });
      };
      ws.on("message", onWelcome);
      // Attached before the handshake settles: the relay flushes the offline
      // queue immediately after the welcome, and a listener attached a microtask
      // later silently loses whatever was waiting for us.
      ws.on("message", (raw) => this.#onMessage(raw));
    });

    ws.on("close", (code, reason) => this.#onClose(code, reason.toString()));
    ws.on("error", (error) => this.log.write("relay_error", { error: error.message }));
  }

  #onMessage(raw) {
    this.inboundChain = this.inboundChain
      .then(() => this.#handleFrame(raw))
      .catch((error) => this.log.write("inbound_frame_failed", { error: error.message }));
  }

  async #handleFrame(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      this.log.write("invalid_relay_message", { error: error.message });
      return;
    }

    if (message.type === "welcome") return;

    if (message.type === "peer_status") {
      try {
        if (message.publicKey) {
          await this.#pinPeer(message.agentId, message.publicKey, message.keyProof, message);
        }
      } catch (error) {
        this.log.write("peer_identity_mismatch", {
          peerId: message.agentId,
          error: error.message,
        });
        this.ws?.close(4010, "peer not admitted");
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
      if (!this.manualAck) this.#sendRaw({ type: "message_ack", id: envelope.id });
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
      peer: this.peerBinding(),
    };
  }

  // The owner still has to compare fingerprints out of band; the short-lived
  // invite is consent to connect, not proof of who answered.
  peerBinding() {
    if (!this.boundPeer) return null;
    return {
      agentId: this.boundPeer.agentId,
      fingerprint: this.boundPeer.fingerprint || publicKeyFingerprint(this.boundPeer.publicKey),
      verification: this.boundPeer.verification === "verified" ? "verified" : "pending",
      boundAt: this.boundPeer.at || null,
      verifiedAt: this.boundPeer.verifiedAt || null,
    };
  }

  async markPeerVerified(fingerprint = null) {
    if (!this.boundPeer) throw new Error("No peer is bound to this room yet");
    const actual = this.boundPeer.fingerprint || publicKeyFingerprint(this.boundPeer.publicKey);
    if (fingerprint && fingerprint !== actual) {
      throw new Error("Fingerprint does not match the bound peer");
    }
    this.boundPeer.fingerprint = actual;
    this.boundPeer.verification = "verified";
    this.boundPeer.verifiedAt = new Date().toISOString();
    await this.#queueTrustSave();
    return this.peerBinding();
  }

  discard(messageId) {
    const index = this.inbox.findIndex((message) => message.id === messageId);
    if (index >= 0) this.inbox.splice(index, 1);
  }

  ack(messageId) {
    this.#sendRaw({ type: "message_ack", id: messageId });
  }

  async #readTrustFile(filePath) {
    try {
      return sanitizeTrust(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
  }

  async #loadTrust() {
    let stored = await this.#readTrustFile(this.trustFile);
    if (!stored) {
      // One-time import from the pre-room-scoped file, and only when it really
      // describes this room.
      const legacy = await this.#readTrustFile(this.legacyTrustFile);
      if (legacy?.boundPeer?.roomId === this.config.roomId) stored = legacy;
    }
    if (!stored) return;
    for (const [agentId, publicKey] of Object.entries(stored.peers)) {
      this.peerKeys.set(agentId, publicKey);
    }
    for (const messageId of stored.seenMessageIds) this.seen.add(messageId);
    if (stored.boundPeer?.roomId === this.config.roomId) this.boundPeer = stored.boundPeer;
  }

  #trustSnapshot() {
    return {
      peers: Object.fromEntries(this.peerKeys),
      boundPeer: this.boundPeer,
      seenMessageIds: [...this.seen],
    };
  }

  async #redeemInvite(agentId, publicKey, invite) {
    const registry = this.inviteRegistry;
    const presented = invite?.inviteId;
    const alreadyBound = this.boundPeer?.agentId === agentId
      && this.boundPeer?.publicKey === publicKey;
    if (!presented) {
      if (this.config.requireInvite && !alreadyBound) {
        throw new Error(`${agentId} presented no invite for this room`);
      }
      return;
    }
    if (!registry) throw new Error("Invite registry is unavailable, refusing to redeem");
    if (!verifyInviteProof(
      this.config.roomId,
      this.config.secret,
      presented,
      agentId,
      publicKey,
      invite.inviteProof,
    )) {
      throw new Error(`Invalid invite proof from ${agentId}`);
    }
    const { changed, rollback } = registry.redeemForPeer({
      inviteId: presented,
      agentId,
      publicKeyFingerprint: publicKeyFingerprint(publicKey),
      roomCode: this.config.roomCode,
    });
    if (!changed) return;
    try {
      this.registrySaveChain = this.registrySaveChain.catch(() => {}).then(() => registry.save());
      await this.registrySaveChain;
    } catch (error) {
      // Fail closed: an unrecorded redemption would let the invite be used again.
      rollback();
      await this.log.write("invite_save_failed", { error: error.message });
      throw new Error(`Could not record invite redemption for ${agentId}: ${error.message}`);
    }
  }

  async #pinPeer(agentId, publicKey, keyProof, invite = null) {
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
    // AgentLink is a two-party link: the first peer that proves room membership
    // owns the room until the owner rotates it. Knowing the room code is not
    // enough to walk in later under a different identity or a new key. Checked
    // before redemption so a peer we are going to refuse cannot burn an invite.
    if (this.boundPeer && this.boundPeer.agentId !== agentId) {
      throw new Error(
        `Room is bound to ${this.boundPeer.agentId}; rotate the room to admit ${agentId}`,
      );
    }
    if (this.boundPeer && this.boundPeer.publicKey !== publicKey) {
      throw new Error(`Room is bound to a different key for ${agentId}; rotate the room to admit it`);
    }
    const existing = this.peerKeys.get(agentId);
    if (existing && existing !== publicKey) {
      throw new Error(`Pinned public key changed for ${agentId}`);
    }
    // The issuer decides here: an invite is redeemed against the peer public
    // key, so a reused agent name with a new key is still refused.
    await this.#redeemInvite(agentId, publicKey, invite);
    if (!this.boundPeer) {
      this.boundPeer = {
        roomId: this.config.roomId,
        agentId,
        publicKey,
        fingerprint: publicKeyFingerprint(publicKey),
        verification: "pending",
        at: new Date().toISOString(),
      };
    }
    if (!existing) {
      this.peerKeys.set(agentId, publicKey);
      void this.#queueTrustSave().catch((error) =>
        this.log.write("trust_save_failed", { error: error.message }),
      );
    }
  }

  async #saveTrust() {
    // Two processes may share one config. An atomic replace prevents corruption
    // but not lost updates, so the read, merge and write happen under one
    // cross-process lock and trust only ever grows.
    await withFileLock(this.trustFile, async () => {
      let onDisk = {};
      try {
        onDisk = JSON.parse(await readFile(this.trustFile, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const merged = mergeTrust(onDisk, this.#trustSnapshot(), { roomId: this.config.roomId });
      for (const [agentId, publicKey] of Object.entries(merged.peers)) {
        const local = this.peerKeys.get(agentId);
        if (local && local !== publicKey) {
          // The persisted key wins so every instance converges on one identity
          // instead of quietly disagreeing in memory.
          await this.log.write("trust_key_conflict", { peerId: agentId });
        }
        this.peerKeys.set(agentId, publicKey);
      }
      for (const id of merged.seenMessageIds) this.seen.add(id);
      if (merged.boundPeer?.roomId === this.config.roomId) this.boundPeer = merged.boundPeer;
      await writeFileAtomic(this.trustFile, `${JSON.stringify(merged, null, 2)}\n`);
    });
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
