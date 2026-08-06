import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyRoom } from "./agent-configs.js";
import { writeFileAtomic } from "./atomic-file.js";
import { BridgeClient } from "./bridge-client.js";
import { brokerEndpoint } from "./broker-endpoint.js";
import { loadBridgeConfig } from "./config.js";
import { createRoomCode } from "./crypto.js";
import { parseInviteCode } from "./invite-code.js";
import { decryptLogValue, encryptLogValue } from "./log-crypto.js";
import { requeueInFlight } from "./lease-state.js";
import { JsonlLogger } from "./logger.js";
import { notifyIncomingRequest, notifyUncollectedResponse } from "./notifier.js";
import {
  BROKER_METHODS,
  BROKER_PROTOCOL_VERSION,
  MAX_CLIENT_PROTOCOL_VERSION,
  MIN_CLIENT_PROTOCOL_VERSION,
} from "./protocol-version.js";
import { activityLimit, migrateStore, recordActivity } from "./store-migration.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(
  process.argv[2] || process.env.AGENT_LINK_CONFIG || ".agent-link/active.json",
);
const endpoint = brokerEndpoint(configPath);
const dedupeTtlMs = Math.max(
  Number(process.env.AGENT_LINK_DEDUPE_TTL_MS || 24 * 60 * 60 * 1_000),
  Number(process.env.AGENT_LINK_PENDING_TTL_MS || 24 * 60 * 60 * 1_000),
);
const claimLeaseMs = Number(process.env.AGENT_LINK_CLAIM_LEASE_MS || 5 * 60 * 1_000);
const maxClaimAttempts = Number(process.env.AGENT_LINK_MAX_CLAIM_ATTEMPTS || 5);
const maxLocalFrameBytes = Number(process.env.AGENT_LINK_MAX_LOCAL_FRAME_BYTES || 512 * 1024);
const responseCacheGraceMs = Number(
  process.env.AGENT_LINK_RESPONSE_CACHE_GRACE_MS || 7 * 24 * 60 * 60 * 1_000,
);
const maxOutboundRequests = Number(process.env.AGENT_LINK_MAX_OUTBOUND_REQUESTS || 1_000);
const runtimePath = `${configPath}.broker-runtime.json`;
const brokerMethods = Object.freeze([...BROKER_METHODS]);
const maxActivityEntries = activityLimit(process.env.AGENT_LINK_MAX_ACTIVITY_ENTRIES);

function initialData() {
  return migrateStore({}, { maxActivity: maxActivityEntries });
}

class EncryptedBrokerStore {
  constructor(filePath, keyMaterial) {
    this.filePath = filePath;
    this.keyMaterial = keyMaterial;
    this.data = initialData();
    this.chain = Promise.resolve();
    this.dirty = false;
  }

  // Activity is a metadata log, not part of the message state machine, so it
  // rides along with the next real save instead of putting a full re-encrypt on
  // the path of every message.
  markDirty() {
    this.dirty = true;
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      this.data = migrateStore(
        decryptLogValue(this.keyMaterial, stored.payload),
        { maxActivity: maxActivityEntries },
      );
      const requeued = requeueInFlight(this.data.messages);
      this.cleanup();
      if (requeued.length) await this.save();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  cleanup() {
    const cutoff = Date.now() - dedupeTtlMs;
    const acknowledgedCutoff = Date.now() - responseCacheGraceMs;
    for (const [requestId, completed] of Object.entries(this.data.completed)) {
      if (Date.parse(completed.completedAt || 0) < cutoff) delete this.data.completed[requestId];
    }
    for (const [requestId, outbound] of Object.entries(this.data.outbound)) {
      const acknowledgedAt = outbound.acknowledgedAt ? Date.parse(outbound.acknowledgedAt) : 0;
      if (acknowledgedAt && acknowledgedAt < acknowledgedCutoff) delete this.data.outbound[requestId];
    }
    const outboundEntries = Object.entries(this.data.outbound);
    if (outboundEntries.length > maxOutboundRequests) {
      outboundEntries
        .filter(([, outbound]) => outbound.acknowledgedAt)
        .sort(([, a], [, b]) => Date.parse(a.acknowledgedAt) - Date.parse(b.acknowledgedAt))
        .slice(0, outboundEntries.length - maxOutboundRequests)
        .forEach(([requestId]) => delete this.data.outbound[requestId]);
    }
  }

  save() {
    this.cleanup();
    this.dirty = false;
    const snapshot = JSON.parse(JSON.stringify(this.data));
    this.chain = this.chain.catch(() => {}).then(async () => {
      const payload = encryptLogValue(this.keyMaterial, snapshot);
      await writeFileAtomic(
        this.filePath,
        `${JSON.stringify({ version: 1, payload }, null, 2)}\n`,
      );
    });
    return this.chain;
  }
}

function requestKey(message) {
  return message.metadata?.requestId || message.id;
}

function routeScore(message, frontend = {}) {
  const route = message.metadata?.routingKey || {};
  if (route.explicitTaskId) {
    return route.explicitTaskId === frontend.taskId ? 300 : -1;
  }
  if (route.workspaceHint) {
    return route.workspaceHint === frontend.workspaceFingerprint ? 200 : -1;
  }
  if (route.tags?.length) {
    const tags = new Set(frontend.tags || []);
    return route.tags.every((tag) => tags.has(tag)) ? 100 + route.tags.length : -1;
  }
  return 0;
}

function matchesWaiter(message, waiter) {
  if (waiter.kinds?.length && !waiter.kinds.includes(message.kind)) return false;
  if (waiter.replyTo?.length) {
    return waiter.replyTo.includes(message.metadata?.replyTo);
  }
  return message.kind !== "request" || routeScore(message, waiter.client.frontend) >= 0;
}

function safeWrite(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

const terminalRequestStates = new Set(["responded", "declined", "expired"]);

function validLocalProof(secret, frontendId, proof) {
  if (!frontendId || !proof) return false;
  try {
    const expected = createHmac("sha256", secret)
      .update(`agent-link-local-broker-v1:${frontendId}`)
      .digest();
    const received = Buffer.from(proof, "base64url");
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

class LocalBroker {
  constructor() {
    this.context = null;
    this.fingerprint = null;
    this.clients = new Map();
    this.waiters = [];
    this.watchers = [];
    this.statusWaiters = [];
    this.reloadQueue = Promise.resolve();
    this.idleTimer = null;
    this.draining = false;
    this.startedAt = new Date().toISOString();
    this.log = new JsonlLogger(
      path.join(path.dirname(configPath), "logs", "broker.jsonl"),
      { component: "broker", configPath },
    );
  }

  async reload() {
    const operation = this.reloadQueue.then(() => this.#reloadNow());
    this.reloadQueue = operation.catch(() => {});
    return operation;
  }

  async #reloadNow() {
    const raw = await readFile(configPath, "utf8");
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    if (this.context?.fingerprint === fingerprint) return this.context;
    const config = await loadBridgeConfig(configPath);
    const store = new EncryptedBrokerStore(
      `${config.configPath}.${config.roomId}.broker.json`,
      config.identity.privateKey,
    );
    await store.load();
    const bridge = new BridgeClient(config, { manualAck: true });
    const context = { config, store, bridge, fingerprint };
    bridge.on("message", (message) => {
      void this.#onBridgeMessage(context, message).catch((error) =>
        this.log.write("incoming_failed", { error: error.message }),
      );
    });
    const previous = this.context;
    this.context = context;
    this.fingerprint = fingerprint;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("AgentLink room changed while waiting"));
    }
    for (const watcher of this.watchers.splice(0)) {
      clearTimeout(watcher.timer);
      watcher.reject(new Error("AgentLink room changed while watching"));
    }
    for (const waiter of this.statusWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("AgentLink room changed while checking request status"));
    }
    for (const client of this.clients.values()) client.authenticated = false;
    void bridge.start();
    if (previous) await previous.bridge.close();
    await this.log.write("config_loaded", { roomId: config.roomId, agentId: config.agentId });
    return context;
  }

  async #ack(context, messageId) {
    try {
      context.bridge.ack(messageId);
    } catch (error) {
      await this.log.write("relay_ack_failed", { messageId, error: error.message });
    }
    context.bridge.discard(messageId);
  }

  async #sendReceipt(context, id, state, reason = null) {
    recordActivity(
      context.store.data,
      { kind: "inbound", messageKind: "request", requestId: id, state, reason },
      maxActivityEntries,
    );
    context.store.markDirty();
    try {
      await context.bridge.send(state, {
        kind: "receipt",
        metadata: {
          displayName: context.config.displayName,
          requestId: id,
          state,
          reason,
          ts: new Date().toISOString(),
        },
      });
    } catch (error) {
      await this.log.write("receipt_send_failed", { requestId: id, state, error: error.message });
    }
  }

  #recordOutboundState(outbound, state, { reason = null, ts = null } = {}) {
    const timestamp = ts || new Date().toISOString();
    outbound.state = state;
    outbound.reason = reason;
    outbound.updatedAt = timestamp;
    outbound.receipts ||= [];
    const previous = outbound.receipts.at(-1);
    if (!previous || previous.state !== state || previous.reason !== reason) {
      outbound.receipts.push({ state, reason, ts: timestamp });
      if (this.context) {
        recordActivity(this.context.store.data, {
          ts: timestamp,
          kind: "outbound",
          messageKind: "request",
          requestId: outbound.requestId,
          state,
          reason,
        }, maxActivityEntries);
      }
    }
    this.#notifyStatusWaiters(outbound.requestId);
  }

  #notifyStatusWaiters(requestId) {
    for (const waiter of [...this.statusWaiters]) {
      if (waiter.requestId && waiter.requestId !== requestId) continue;
      const position = this.statusWaiters.indexOf(waiter);
      if (position >= 0) this.statusWaiters.splice(position, 1);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  #outboundSummary(outbound) {
    return {
      request_id: outbound.requestId,
      state: outbound.state,
      age_seconds: Math.max(0, Math.floor(
        (Date.now() - Date.parse(outbound.createdAt || new Date().toISOString())) / 1_000,
      )),
      deadline: outbound.deadline || null,
      question_head: outbound.questionHead || "(legacy request)",
      reason: outbound.reason || null,
      acknowledged: Boolean(outbound.acknowledgedAt),
    };
  }

  async #explicitOutboundStatus(context, outbound) {
    if (terminalRequestStates.has(outbound.state) && !outbound.acknowledgedAt) {
      outbound.acknowledgedAt = new Date().toISOString();
      outbound.updatedAt = outbound.acknowledgedAt;
      await context.store.save();
    }
    return {
      ...this.#outboundSummary(outbound),
      response_body: outbound.state === "responded" ? outbound.response?.text || null : null,
      receipt_timestamps: outbound.receipts || [],
      acknowledged_at: outbound.acknowledgedAt || null,
    };
  }

  #outboundForClient(client, { includeAcknowledged = false, allTasks = false } = {}) {
    return Object.values(this.context.store.data.outbound)
      .filter((outbound) => allTasks || outbound.ownerTaskId === client.frontend.taskId)
      .filter((outbound) => includeAcknowledged || !outbound.acknowledgedAt)
      .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  }

  #waitForStatusChange(client, requestId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { client, requestId, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const position = this.statusWaiters.indexOf(waiter);
          if (position >= 0) this.statusWaiters.splice(position, 1);
          resolve();
        }, timeoutMs);
      }
      this.statusWaiters.push(waiter);
    });
  }

  async #expireOutboundIfNeeded(context, outbound) {
    if (
      !terminalRequestStates.has(outbound.state)
      && outbound.deadline
      && Date.parse(outbound.deadline) <= Date.now()
    ) {
      this.#recordOutboundState(outbound, "expired");
      await context.store.save();
    }
  }

  async #requestStatus(client, params) {
    const context = this.context;
    const id = params.requestId?.trim() || null;
    if (id) {
      let outbound = context.store.data.outbound[id];
      if (!outbound) throw new Error("Outbound request not found");
      await this.#expireOutboundIfNeeded(context, outbound);
      if (params.waitMs > 0 && !terminalRequestStates.has(outbound.state)) {
        await this.#waitForStatusChange(client, id, params.waitMs);
        outbound = context.store.data.outbound[id] || outbound;
        await this.#expireOutboundIfNeeded(context, outbound);
      }
      return this.#explicitOutboundStatus(context, outbound);
    }

    let requests = this.#outboundForClient(client, {
      includeAcknowledged: Boolean(params.includeAcknowledged),
      allTasks: Boolean(params.allTasks),
    });
    if (params.waitMs > 0 && requests.every((item) => !terminalRequestStates.has(item.state))) {
      await this.#waitForStatusChange(client, null, params.waitMs);
      requests = this.#outboundForClient(client, {
        includeAcknowledged: Boolean(params.includeAcknowledged),
        allTasks: Boolean(params.allTasks),
      });
    }
    return { requests: requests.map((outbound) => this.#outboundSummary(outbound)) };
  }

  async #notifyUncollectedIfNeeded(context, outbound, { force = false } = {}) {
    if (outbound.state !== "responded" || outbound.acknowledgedAt || outbound.uncollectedNotifiedAt) {
      return;
    }
    const taskAlive = [...this.clients.values()].some(
      (client) => client.authenticated && client.frontend.taskId === outbound.ownerTaskId,
    );
    if (taskAlive && !force) return;
    outbound.uncollectedNotifiedAt = new Date().toISOString();
    await context.store.save();
    const count = Object.values(context.store.data.outbound).filter(
      (item) => item.state === "responded" && !item.acknowledgedAt,
    ).length;
    void notifyUncollectedResponse({
      pendingCount: count,
      settingsPath: path.join(path.dirname(context.config.configPath), "notifications.json"),
    });
  }

  async #onBridgeMessage(context, message) {
    if (context !== this.context) return;
    const store = context.store;
    if (message.kind === "receipt") {
      const id = message.metadata?.requestId;
      if (id && store.data.outbound[id]) {
        this.#recordOutboundState(
          store.data.outbound[id],
          message.metadata?.state || message.text,
          { reason: message.metadata?.reason || null, ts: message.metadata?.ts || null },
        );
        await store.save();
      }
      await this.#ack(context, message.id);
      this.#broadcast("receipt", message);
      return;
    }

    if (message.kind === "response") {
      const replyTo = message.metadata?.replyTo;
      const outbound = Object.values(store.data.outbound).find(
        (item) => item.requestId === replyTo || item.envelopeId === replyTo,
      );
      if (outbound) {
        if (outbound.response) {
          await this.#ack(context, message.id);
          return;
        }
        const activeCollector = this.statusWaiters.some(
          (waiter) => (!waiter.requestId || waiter.requestId === outbound.requestId)
            && waiter.client.frontend.taskId === outbound.ownerTaskId,
        );
        outbound.response = message;
        recordActivity(store.data, {
          kind: "inbound",
          messageKind: "response",
          requestId: outbound.requestId,
          peer: message.metadata?.displayName || message.from,
          state: "received",
        }, maxActivityEntries);
        this.#recordOutboundState(outbound, "responded", { ts: message.receivedAt });
        await store.save();
        await this.#ack(context, message.id);
        this.#broadcast("message", message);
        await this.#notifyUncollectedIfNeeded(context, outbound, { force: !activeCollector });
        return;
      }
    }

    if (message.kind === "request") {
      const id = requestKey(message);
      const completed = store.data.completed[id];
      if (completed) {
        await context.bridge.send(completed.body, {
          kind: "response",
          metadata: {
            displayName: context.config.displayName,
            replyTo: id,
            replayed: true,
          },
        });
        await this.#ack(context, message.id);
        return;
      }
      const duplicate = store.data.messages.find(
        (entry) => entry.message.kind === "request" && entry.requestId === id,
      );
      if (duplicate) {
        await this.#sendReceipt(context, id, duplicate.state);
        await this.#ack(context, message.id);
        return;
      }
      const deadline = Date.parse(message.metadata?.deadline || 0);
      if (deadline && deadline <= Date.now()) {
        await this.#sendReceipt(context, id, "expired");
        await this.#ack(context, message.id);
        return;
      }
    }

    const entry = {
      message,
      requestId: message.kind === "request" ? requestKey(message) : null,
      state: "queued",
      attempts: 0,
      receivedAt: new Date().toISOString(),
    };
    recordActivity(store.data, {
      kind: "inbound",
      messageKind: message.kind,
      requestId: entry.requestId,
      peer: message.metadata?.displayName || message.from,
      state: "received",
    }, maxActivityEntries);
    store.data.messages.push(entry);
    await store.save();
    await this.#ack(context, message.id);
    this.#broadcast("message", message);

    if (message.kind === "request") {
      await this.#sendReceipt(context, entry.requestId, "queued");
      const pendingCount = store.data.messages.filter(
        (item) => item.message.kind === "request" && item.state === "queued",
      ).length;
      void notifyIncomingRequest({
        peerAlias: message.metadata?.displayName || message.from,
        pendingCount,
        settingsPath: path.join(path.dirname(context.config.configPath), "notifications.json"),
      });
    }
    await this.#dispatch();
  }

  #broadcast(event, data) {
    for (const client of this.clients.values()) {
      safeWrite(client.socket, { type: "event", event, data });
    }
  }

  async #consume(entry, client) {
    const { store } = this.context;
    if (entry.message.kind === "request") {
      entry.state = "claimed";
      entry.claimedBy = client.id;
      entry.leaseUntil = new Date(Date.now() + claimLeaseMs).toISOString();
      await store.save();
      await this.#sendReceipt(this.context, entry.requestId, "claimed");
      return entry.message;
    }
    const index = store.data.messages.indexOf(entry);
    if (index >= 0) store.data.messages.splice(index, 1);
    await store.save();
    return entry.message;
  }

  async #dispatch() {
    const { store } = this.context;
    for (const entry of store.data.messages) {
      if (entry.state !== "queued") continue;
      const candidates = this.waiters.filter((waiter) => matchesWaiter(entry.message, waiter));
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        const score = routeScore(entry.message, b.client.frontend)
          - routeScore(entry.message, a.client.frontend);
        return score || a.createdAt - b.createdAt;
      });
      const waiter = candidates[0];
      const position = this.waiters.indexOf(waiter);
      if (position >= 0) this.waiters.splice(position, 1);
      clearTimeout(waiter.timer);
      try {
        waiter.resolve(await this.#consume(entry, waiter.client));
      } catch (error) {
        waiter.reject(error);
      }
    }
    for (const entry of store.data.messages) {
      if (entry.state !== "queued" || entry.message.kind !== "request") continue;
      const candidates = this.watchers.filter(
        (watcher) => routeScore(entry.message, watcher.client.frontend) >= 0,
      );
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        const score = routeScore(entry.message, b.client.frontend)
          - routeScore(entry.message, a.client.frontend);
        return score || a.createdAt - b.createdAt;
      });
      const watcher = candidates[0];
      const position = this.watchers.indexOf(watcher);
      if (position >= 0) this.watchers.splice(position, 1);
      clearTimeout(watcher.timer);
      watcher.resolve({
        requestId: entry.requestId,
        from: entry.message.from,
        displayName: entry.message.metadata?.displayName || entry.message.from,
        deadline: entry.message.metadata?.deadline || null,
      });
    }
  }

  #watch(client, params) {
    const existing = this.context.store.data.messages.find(
      (entry) => entry.state === "queued"
        && entry.message.kind === "request"
        && routeScore(entry.message, client.frontend) >= 0,
    );
    if (existing) {
      return Promise.resolve({
        requestId: existing.requestId,
        from: existing.message.from,
        displayName: existing.message.metadata?.displayName || existing.message.from,
        deadline: existing.message.metadata?.deadline || null,
      });
    }
    return new Promise((resolve, reject) => {
      const watcher = { client, createdAt: Date.now(), resolve, reject, timer: null };
      if (params.timeoutMs > 0) {
        watcher.timer = setTimeout(() => {
          const index = this.watchers.indexOf(watcher);
          if (index >= 0) this.watchers.splice(index, 1);
          reject(new Error(`No queued request within ${params.timeoutMs}ms`));
        }, params.timeoutMs);
      }
      this.watchers.push(watcher);
    });
  }

  async #wait(client, params) {
    const kinds = params.kinds || null;
    const replyTo = params.replyTo
      ? (Array.isArray(params.replyTo) ? params.replyTo : [params.replyTo])
      : null;
    const existing = this.context.store.data.messages.find((entry) =>
      entry.state === "queued" && matchesWaiter(entry.message, { kinds, replyTo, client }),
    );
    if (existing) return this.#consume(existing, client);
    return new Promise((resolve, reject) => {
      const waiter = {
        client,
        kinds,
        replyTo,
        createdAt: Date.now(),
        resolve,
        reject,
        timer: null,
      };
      if (params.timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`No peer message within ${params.timeoutMs}ms`));
        }, params.timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  async #sendRequest(client, params) {
    const context = this.context;
    const question = params.question?.trim();
    if (!question) throw new Error("question is required");
    const id = params.requestId || randomUUID();
    if (typeof id !== "string" || id.length < 8 || id.length > 128) {
      throw new Error("requestId must contain 8 to 128 characters");
    }
    const questionHash = createHash("sha256").update(question).digest("hex");
    let outbound = context.store.data.outbound[id];
    if (outbound?.questionHash && outbound.questionHash !== questionHash) {
      throw new Error("requestId was already used for a different question");
    }
    if (!outbound) {
      if (Object.keys(context.store.data.outbound).length >= maxOutboundRequests) {
        throw new Error("Outbound request cache is full; collect or expire older requests first");
      }
      const deadline = params.deadline || new Date(
        Date.now() + 24 * 60 * 60 * 1_000,
      ).toISOString();
      const deadlineMs = Date.parse(deadline);
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
        throw new Error("deadline must be a future absolute date-time");
      }
      outbound = {
        requestId: id,
        questionHash,
        questionHead: question.replace(/\s+/g, " ").slice(0, 80),
        ownerTaskId: client.frontend.taskId,
        ownerFrontendId: client.frontend.frontendId,
        state: "queued_local",
        deadline,
        receipts: [{ state: "queued_local", reason: null, ts: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
      };
      context.store.data.outbound[id] = outbound;
      await context.store.save();
    } else {
      outbound.questionHash ||= questionHash;
      outbound.questionHead ||= question.replace(/\s+/g, " ").slice(0, 80);
      outbound.ownerTaskId ||= client.frontend.taskId;
      outbound.ownerFrontendId ||= client.frontend.frontendId;
      outbound.createdAt ||= new Date().toISOString();
      outbound.deadline ||= params.deadline || new Date(
        Date.now() + 24 * 60 * 60 * 1_000,
      ).toISOString();
      outbound.receipts ||= [];
    }
    if (!outbound.envelopeId) {
      try {
        outbound.envelopeId = await context.bridge.send(question, {
          kind: "request",
          metadata: {
            displayName: context.config.displayName,
            requestId: id,
            routingKey: params.routingKey || {},
            deadline: outbound.deadline,
          },
        });
        this.#recordOutboundState(outbound, "relay_acked");
      } catch (error) {
        if (/pending queue is full/i.test(error.message)) {
          this.#recordOutboundState(outbound, "declined", { reason: "room_pending_queue_full" });
        }
        await context.store.save();
        if (outbound.state !== "declined") throw error;
      }
      await context.store.save();
    }
    return outbound;
  }

  async #ask(client, params) {
    const outbound = await this.#sendRequest(client, params);
    const startedAt = Date.now();
    while (!terminalRequestStates.has(outbound.state)) {
      const remaining = params.timeoutMs > 0
        ? Math.max(0, params.timeoutMs - (Date.now() - startedAt))
        : 0;
      if (params.timeoutMs > 0 && remaining === 0) break;
      await this.#waitForStatusChange(client, outbound.requestId, remaining);
    }
    await this.#expireOutboundIfNeeded(this.context, outbound);
    const status = await this.#explicitOutboundStatus(this.context, outbound);
    return { response: outbound.response || null, status };
  }

  async #respond(client, params) {
    const context = this.context;
    const entry = context.store.data.messages.find(
      (item) => item.message.kind === "request"
        && (item.requestId === params.requestId || item.message.id === params.requestId),
    );
    if (!entry) throw new Error("Unknown or already answered request_id");
    if (!["claimed", "processing"].includes(entry.state) || entry.claimedBy !== client.id) {
      throw new Error("This frontend has not claimed the request");
    }
    const body = params.text?.trim();
    if (!body) throw new Error("response text is required");
    context.store.data.completed[entry.requestId] = {
      body,
      completedAt: new Date().toISOString(),
    };
    await context.store.save();
    const responseId = await context.bridge.send(body, {
      kind: "response",
      metadata: {
        ...(params.metadata || {}),
        displayName: context.config.displayName,
        replyTo: entry.requestId,
      },
    });
    recordActivity(context.store.data, {
      kind: "outbound",
      messageKind: "response",
      requestId: entry.requestId,
      state: "sent",
    }, maxActivityEntries);
    const entryIndex = context.store.data.messages.indexOf(entry);
    if (entryIndex >= 0) context.store.data.messages.splice(entryIndex, 1);
    await context.store.save();
    await this.#sendReceipt(context, entry.requestId, "responded");
    return { requestId: entry.requestId, responseId };
  }

  async #release(client, requestId) {
    const entry = this.context.store.data.messages.find(
      (item) => item.requestId === requestId || item.message.id === requestId,
    );
    if (!entry || entry.claimedBy !== client.id) return { released: false };
    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.state = entry.attempts >= maxClaimAttempts ? "dead_letter" : "queued";
    delete entry.claimedBy;
    delete entry.leaseUntil;
    await this.context.store.save();
    if (entry.state === "dead_letter") {
      await this.#sendReceipt(this.context, entry.requestId, "declined", "claim attempt limit reached");
      void notifyIncomingRequest({
        peerAlias: entry.message.metadata?.displayName || entry.message.from,
        pendingCount: this.context.store.data.messages.filter(
          (item) => item.message.kind === "request" && item.state !== "responded",
        ).length,
        settingsPath: path.join(path.dirname(this.context.config.configPath), "notifications.json"),
      });
    }
    await this.#dispatch();
    return { released: true, state: entry.state };
  }

  async #handle(client, method, params) {
    if (method === "hello") return this.describe();
    await this.reload();
    const context = this.context;
    if (method === "takeover") {
      if (!validLocalProof(context.config.secret, params.frontendId, params.proof)) {
        throw new Error("Local broker authentication failed");
      }
      const requeued = await this.beginTakeover(String(params.reason || "frontend upgrade").slice(0, 200));
      setTimeout(() => void shutdown("takeover"), 10).unref();
      return { accepted: true, pid: process.pid, requeued };
    }
    if (this.draining) throw new Error("Local broker is handing over to a newer instance");
    if (method === "register") {
      const frontend = params.frontend || {};
      if (!validLocalProof(context.config.secret, frontend.frontendId, params.proof)) {
        throw new Error("Local broker authentication failed");
      }
      client.frontend = { ...frontend };
      client.authenticated = true;
      return { ...this.describe(), frontendId: client.frontend.frontendId };
    }
    if (!client.authenticated) throw new Error("Frontend must register with the local broker");
    if (method === "status") {
      return {
        ...context.bridge.status(),
        broker: true,
        endpoint,
        frontends: this.clients.size,
        roomName: context.config.roomName || null,
        inbox: context.store.data.messages.filter((entry) => entry.message.kind === "request").length,
        queued: context.store.data.messages.filter((entry) => entry.state === "queued").length,
      };
    }
    if (method === "send") {
      const messageId = await context.bridge.send(params.text, {
        kind: params.kind,
        metadata: params.metadata,
        to: params.to,
      });
      recordActivity(context.store.data, {
        kind: "outbound",
        messageKind: params.kind || "chat",
        requestId: params.metadata?.requestId || params.metadata?.replyTo || null,
        state: "sent",
      }, maxActivityEntries);
      context.store.markDirty();
      return { messageId };
    }
    if (method === "wait") return this.#wait(client, params);
    if (method === "watch") return this.#watch(client, params);
    if (method === "request_send") {
      const outbound = await this.#sendRequest(client, params);
      return this.#outboundSummary(outbound);
    }
    if (method === "request_status") return this.#requestStatus(client, params);
    if (method === "ask") return this.#ask(client, params);
    if (method === "mark_processing") {
      const entry = context.store.data.messages.find(
        (item) => item.message.kind === "request"
          && (item.requestId === params.requestId || item.message.id === params.requestId),
      );
      if (!entry || entry.state !== "claimed" || entry.claimedBy !== client.id) {
        throw new Error("This frontend has not claimed the request");
      }
      entry.state = "processing";
      entry.leaseUntil = new Date(Date.now() + claimLeaseMs).toISOString();
      await context.store.save();
      await this.#sendReceipt(context, entry.requestId, "processing");
      return { requestId: entry.requestId, state: entry.state };
    }
    if (method === "respond") return this.#respond(client, params);
    if (method === "inbox_list") {
      return context.store.data.messages
        .filter((entry) => entry.message.kind === "request")
        .map((entry) => ({
          requestId: entry.requestId,
          state: entry.state,
          receivedAt: entry.receivedAt,
          deadline: entry.message.metadata?.deadline || null,
          routingKey: entry.message.metadata?.routingKey || {},
          from: entry.message.from,
          displayName: entry.message.metadata?.displayName || entry.message.from,
          text: entry.message.text,
        }));
    }
    // Room and invite control. Every agent config on this machine is rewritten
    // together, because each MCP server was launched with its own file and would
    // otherwise stay in the previous room while the window shows the new one.
    if (method === "room_create") {
      const roomName = String(params.name || "").slice(0, 64) || null;
      const updated = await applyRoom(path.dirname(context.config.configPath), {
        roomCode: createRoomCode(),
        roomName,
        relayUrl: params.relayUrl || context.config.relayUrl,
      });
      await this.reload();
      return { roomName, agents: updated };
    }
    if (method === "room_join") {
      const invite = parseInviteCode(params.invite);
      const updated = await applyRoom(path.dirname(context.config.configPath), {
        roomCode: invite.roomCode,
        roomName: invite.label,
        relayUrl: invite.relayUrl,
        inviteId: invite.inviteId,
      });
      await this.reload();
      return { roomName: invite.label, expiresAt: invite.expiresAt, agents: updated };
    }
    if (method === "invite_create") {
      const invite = await context.bridge.issueInvite({
        ttlMs: params.ttlMs,
        label: params.label,
      });
      return invite;
    }
    if (method === "invite_list") return { invites: await context.bridge.listInvites() };
    if (method === "invite_revoke") return context.bridge.revokeInvite(params.inviteId);
    if (method === "peer_verify") return context.bridge.markPeerVerified(params.fingerprint);
    if (method === "activity_tail") {
      const activity = context.store.data.activity || [];
      const limit = Math.min(Math.max(Math.floor(Number(params.limit) || 100), 1), maxActivityEntries);
      return { activity: activity.slice(-limit), total: activity.length, limit };
    }
    if (method === "inbox_claim") {
      const entry = context.store.data.messages.find(
        (item) => item.message.kind === "request"
          && item.state === "queued"
          && (item.requestId === params.requestId || item.message.id === params.requestId),
      );
      if (!entry) throw new Error("Queued request not found");
      return this.#consume(entry, client);
    }
    if (method === "release") return this.#release(client, params.requestId);
    if (method === "discard") {
      const index = context.store.data.messages.findIndex(
        (entry) => entry.message.id === params.messageId || entry.requestId === params.messageId,
      );
      if (index >= 0) context.store.data.messages.splice(index, 1);
      await context.store.save();
      return { discarded: index >= 0 };
    }
    if (method === "shutdown" && process.env.AGENT_LINK_ALLOW_BROKER_SHUTDOWN === "1") {
      setTimeout(() => void shutdown("rpc"), 10).unref();
      return { stopping: true };
    }
    throw new Error(`Unknown broker method: ${method}`);
  }

  describe() {
    return {
      brokerProtocol: BROKER_PROTOCOL_VERSION,
      minClientProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxClientProtocol: MAX_CLIENT_PROTOCOL_VERSION,
      methods: brokerMethods,
      pid: process.pid,
      startedAt: this.startedAt,
      draining: this.draining,
      endpoint,
    };
  }

  async noteLifecycle(state, reason = null) {
    if (!this.context) return;
    recordActivity(this.context.store.data, { kind: "broker", state, reason }, maxActivityEntries);
    await this.context.store.save();
  }

  async beginTakeover(reason) {
    if (this.draining) return 0;
    this.draining = true;
    const requeued = requeueInFlight(this.context?.store.data.messages || []);
    await this.noteLifecycle("takeover", reason);
    await this.log.write("broker_takeover", { reason, requeued: requeued.length });
    return requeued.length;
  }

  accept(socket) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const client = {
      id: randomUUID(),
      socket,
      frontend: { taskId: `unregistered-${randomUUID()}`, tags: [] },
      authenticated: false,
      buffer: "",
    };
    this.clients.set(client.id, client);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      client.buffer += chunk;
      if (Buffer.byteLength(client.buffer) > maxLocalFrameBytes) {
        socket.destroy(new Error("Local broker frame is too large"));
        return;
      }
      while (true) {
        const newline = client.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = client.buffer.slice(0, newline);
        client.buffer = client.buffer.slice(newline + 1);
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        void this.#handle(client, request.method, request.params || {}).then(
          (result) => safeWrite(socket, { id: request.id, ok: true, result }),
          (error) => safeWrite(socket, { id: request.id, ok: false, error: error.message }),
        );
      }
    });
    socket.on("close", () => void this.#disconnect(client));
    socket.on("error", () => {});
  }

  async #disconnect(client) {
    if (!this.clients.delete(client.id)) return;
    const deadLetters = [];
    for (const waiter of [...this.waiters]) {
      if (waiter.client !== client) continue;
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Frontend disconnected while waiting"));
    }
    for (const watcher of [...this.watchers]) {
      if (watcher.client !== client) continue;
      const index = this.watchers.indexOf(watcher);
      if (index >= 0) this.watchers.splice(index, 1);
      clearTimeout(watcher.timer);
      watcher.reject(new Error("Frontend disconnected while watching"));
    }
    for (const waiter of [...this.statusWaiters]) {
      if (waiter.client !== client) continue;
      const index = this.statusWaiters.indexOf(waiter);
      if (index >= 0) this.statusWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Frontend disconnected while checking request status"));
    }
    for (const entry of this.draining ? [] : this.context?.store.data.messages || []) {
      if (!["claimed", "processing"].includes(entry.state) || entry.claimedBy !== client.id) continue;
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.state = entry.attempts >= maxClaimAttempts ? "dead_letter" : "queued";
      delete entry.claimedBy;
      delete entry.leaseUntil;
      if (entry.state === "dead_letter") deadLetters.push(entry);
    }
    await this.context?.store.save();
    for (const outbound of Object.values(this.context?.store.data.outbound || {})) {
      if (outbound.ownerTaskId === client.frontend.taskId) {
        await this.#notifyUncollectedIfNeeded(this.context, outbound);
      }
    }
    for (const entry of deadLetters) {
      await this.#sendReceipt(this.context, entry.requestId, "declined", "claim attempt limit reached");
    }
    await this.#dispatch();
    const idleExitMs = Number(process.env.AGENT_LINK_BROKER_IDLE_EXIT_MS || 0);
    if (this.clients.size === 0 && idleExitMs > 0) {
      this.idleTimer = setTimeout(() => void shutdown("idle"), idleExitMs);
      this.idleTimer.unref();
    }
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Broker is shutting down"));
    }
    for (const watcher of this.watchers.splice(0)) {
      clearTimeout(watcher.timer);
      watcher.reject(new Error("Broker is shutting down"));
    }
    for (const waiter of this.statusWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Broker is shutting down"));
    }
    for (const client of this.clients.values()) client.socket.destroy();
    await this.context?.bridge.close();
    await this.context?.store.save();
    await this.log.flush();
  }

  async maintain() {
    const context = this.context;
    if (!context) return;
    let changed = false;
    const expired = [];
    const deadLetters = [];
    const now = Date.now();
    for (const entry of [...context.store.data.messages]) {
      const deadline = Date.parse(entry.message.metadata?.deadline || 0);
      if (entry.message.kind === "request" && deadline && deadline <= now) {
        context.store.data.messages.splice(context.store.data.messages.indexOf(entry), 1);
        expired.push(entry);
        changed = true;
        continue;
      }
      if (!["claimed", "processing"].includes(entry.state) || Date.parse(entry.leaseUntil || 0) > now) continue;
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.state = entry.attempts >= maxClaimAttempts ? "dead_letter" : "queued";
      delete entry.claimedBy;
      delete entry.leaseUntil;
      if (entry.state === "dead_letter") deadLetters.push(entry);
      changed = true;
    }
    for (const outbound of Object.values(context.store.data.outbound)) {
      if (
        !terminalRequestStates.has(outbound.state)
        && outbound.deadline
        && Date.parse(outbound.deadline) <= now
      ) {
        this.#recordOutboundState(outbound, "expired");
        changed = true;
      }
    }
    if (changed) {
      await context.store.save();
      for (const entry of expired) await this.#sendReceipt(context, entry.requestId, "expired");
      for (const entry of deadLetters) {
        await this.#sendReceipt(context, entry.requestId, "declined", "claim attempt limit reached");
      }
      await this.#dispatch();
    }
    for (const outbound of Object.values(context.store.data.outbound)) {
      await this.#notifyUncollectedIfNeeded(context, outbound);
    }
    if (context.store.dirty) await context.store.save();
  }
}

const broker = new LocalBroker();
const server = net.createServer((socket) => broker.accept(socket));

async function removeStaleUnixSocket() {
  if (process.platform === "win32") return;
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    }).then(async (stale) => {
      if (stale) await unlink(endpoint).catch(() => {});
    });
  } catch {
    await unlink(endpoint).catch(() => {});
  }
}

await removeStaleUnixSocket();
await new Promise((resolve, reject) => {
  const onError = (error) => {
    if (error.code === "EADDRINUSE") process.exit(0);
    reject(error);
  };
  server.once("error", onError);
  server.listen(endpoint, () => {
    server.off("error", onError);
    resolve();
  });
});
await broker.reload();
await broker.noteLifecycle("started");
await mkdir(path.dirname(runtimePath), { recursive: true });
await writeFile(
  runtimePath,
  `${JSON.stringify(broker.describe(), null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
void broker.log.write("broker_listening", { endpoint, rootDir });

const reloadTimer = setInterval(() => {
  void broker.reload().catch((error) => broker.log.write("reload_failed", { error: error.message }));
}, 500);
reloadTimer.unref();

const maintenanceTimer = setInterval(() => {
  void broker.maintain().catch((error) =>
    broker.log.write("maintenance_failed", { error: error.message }),
  );
}, 5_000);
maintenanceTimer.unref();

async function clearRuntimeInfo() {
  try {
    const current = JSON.parse(await readFile(runtimePath, "utf8"));
    if (current.pid !== process.pid) return;
  } catch {
    return;
  }
  await unlink(runtimePath).catch(() => {});
}

async function shutdown(signal) {
  clearInterval(reloadTimer);
  clearInterval(maintenanceTimer);
  await broker.log.write("broker_stopping", { signal });
  await broker.close();
  await clearRuntimeInfo();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
