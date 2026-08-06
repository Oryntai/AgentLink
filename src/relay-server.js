import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { JsonlLogger } from "./logger.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.AGENT_LINK_HOST || "127.0.0.1";
const port = Number(process.env.AGENT_LINK_PORT || process.env.PORT || 8787);
const dataFile = path.resolve(
  process.env.AGENT_LINK_DATA_FILE || path.join(rootDir, "data", "relay-state.json"),
);
const log = new JsonlLogger(path.join(rootDir, "logs", "relay.jsonl"), {
  component: "relay",
});
const limits = {
  maxRooms: Number(process.env.AGENT_LINK_MAX_ROOMS || 1_000),
  maxPendingPerRoom: Number(process.env.AGENT_LINK_MAX_PENDING_PER_ROOM || 500),
  messagesPerMinute: Number(process.env.AGENT_LINK_MESSAGES_PER_MINUTE || 120),
  pendingTtlMs: Number(process.env.AGENT_LINK_PENDING_TTL_MS || 24 * 60 * 60 * 1_000),
  roomTtlMs: Number(process.env.AGENT_LINK_ROOM_TTL_MS || 7 * 24 * 60 * 60 * 1_000),
};

const rooms = new Map();
const sockets = new Map();
let persistChain = Promise.resolve();
let persistTimer = null;
const rateWindows = new Map();

function roomForStorage(room) {
  return {
    auth: room.auth,
    members: [...room.members],
    memberKeys: Object.fromEntries(room.memberKeys || []),
    memberProofs: Object.fromEntries(room.memberProofs || []),
    memberInvites: Object.fromEntries(room.memberInvites || []),
    memberLastSeen: Object.fromEntries(room.memberLastSeen || []),
    pending: [...room.pending.values()],
    lastActivity: room.lastActivity,
  };
}

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(dataFile, "utf8"));
    for (const [roomId, room] of Object.entries(raw.rooms || {})) {
      rooms.set(roomId, {
        auth: room.auth,
        members: new Set(room.members || []),
        memberKeys: new Map(Object.entries(room.memberKeys || {})),
        memberProofs: new Map(Object.entries(room.memberProofs || {})),
        memberInvites: new Map(Object.entries(room.memberInvites || {})),
        memberLastSeen: new Map(Object.entries(room.memberLastSeen || {})),
        pending: new Map((room.pending || []).map((item) => [item.id, item])),
        lastActivity: Number(room.lastActivity || Date.now()),
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function persistState() {
  persistChain = persistChain.then(async () => {
    await mkdir(path.dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.tmp`;
    const stored = {
      version: 1,
      rooms: Object.fromEntries(
        [...rooms.entries()].map(([id, room]) => [id, roomForStorage(room)]),
      ),
    };
    await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(tmp, dataFile);
  });
  return persistChain;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistState().catch((error) => log.write("persist_failed", { error: error.message }));
  }, 100);
}

async function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistState();
}

function rateAllowed(roomId, agentId) {
  const key = `${roomId}:${agentId}`;
  const now = Date.now();
  let window = rateWindows.get(key);
  if (!window || now - window.startedAt >= 60_000) {
    window = { startedAt: now, count: 0 };
    rateWindows.set(key, window);
  }
  window.count += 1;
  return window.count <= limits.messagesPerMinute;
}

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function socketKey(roomId, agentId) {
  return `${roomId}:${agentId}`;
}

function socketsFor(roomId, agentId) {
  return sockets.get(socketKey(roomId, agentId)) || new Set();
}

function sendToAgent(roomId, agentId, message) {
  for (const socket of socketsFor(roomId, agentId)) send(socket, message);
}

function deliverPending(roomId, recipientId) {
  const room = rooms.get(roomId);
  const recipients = socketsFor(roomId, recipientId);
  if (!room || recipients.size === 0) return;
  for (const envelope of room.pending.values()) {
    if (envelope.from !== recipientId && (!envelope.to || envelope.to === recipientId)) {
      for (const recipient of recipients) send(recipient, { type: "message", envelope });
    }
  }
}

await loadState();

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/readyz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });

wss.on("connection", (ws) => {
  let identity = null;
  const helloTimer = setTimeout(() => ws.close(4000, "hello timeout"), 10_000);

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      ws.close(4001, "invalid json");
      return;
    }

    if (!identity) {
      if (message.type !== "hello") {
        ws.close(4002, "hello required");
        return;
      }
      const { roomId, auth, agentId, role, publicKey, keyProof, inviteId, inviteProof } = message;
      if (
        !roomId ||
        !auth ||
        !agentId ||
        !publicKey ||
        !keyProof ||
        !["initiator", "responder"].includes(role)
      ) {
        ws.close(4003, "invalid hello");
        return;
      }
      let room = rooms.get(roomId);
      if (!room) {
        if (rooms.size >= limits.maxRooms) {
          ws.close(4007, "room capacity reached");
          return;
        }
        room = {
          auth,
          members: new Set(),
          memberKeys: new Map(),
          memberProofs: new Map(),
          memberInvites: new Map(),
          memberLastSeen: new Map(),
          pending: new Map(),
          lastActivity: Date.now(),
        };
        rooms.set(roomId, room);
      }
      if (room.auth !== auth) {
        ws.close(4004, "unauthorized");
        return;
      }
      if (!room.members.has(agentId) && room.members.size >= 2) {
        ws.close(4005, "room full");
        return;
      }
      const knownKey = room.memberKeys.get(agentId);
      if (knownKey && knownKey !== publicKey) {
        ws.close(4009, "agent identity key mismatch");
        return;
      }

      clearTimeout(helloTimer);
      identity = { roomId, agentId, role };
      room.members.add(agentId);
      room.memberKeys.set(agentId, publicKey);
      room.memberProofs.set(agentId, keyProof);
      room.memberInvites ||= new Map();
      // Opaque to the relay: an id plus a proof it cannot compute or verify.
      if (inviteId && inviteProof) {
        room.memberInvites.set(agentId, {
          inviteId: String(inviteId).slice(0, 128),
          inviteProof: String(inviteProof).slice(0, 256),
        });
      }
      room.memberLastSeen.set(agentId, Date.now());
      room.lastActivity = Date.now();
      const key = socketKey(roomId, agentId);
      const agentSockets = sockets.get(key) || new Set();
      agentSockets.add(ws);
      sockets.set(key, agentSockets);
      schedulePersist();
      await log.write("client_connected", identity);
      send(ws, {
        type: "welcome",
        roomId,
        role,
        peers: [...room.members]
          .filter((id) => id !== agentId)
          .map((id) => ({
            agentId: id,
            publicKey: room.memberKeys.get(id),
            keyProof: room.memberProofs.get(id),
            ...(room.memberInvites?.get(id) || {}),
          })),
      });
      for (const member of room.members) {
        if (member !== agentId) {
          sendToAgent(roomId, member, {
            type: "peer_status",
            agentId,
            publicKey,
            keyProof,
            ...(room.memberInvites?.get(agentId) || {}),
            online: true,
          });
        }
      }
      deliverPending(roomId, agentId);
      return;
    }

    const room = rooms.get(identity.roomId);
    if (message.type === "message") {
      const envelope = message.envelope;
      if (
        !envelope?.id ||
        envelope.version !== 2 ||
        envelope.roomId !== identity.roomId ||
        envelope.from !== identity.agentId ||
        !envelope.encrypted
      ) {
        send(ws, { type: "error", id: envelope?.id, error: "invalid envelope" });
        return;
      }
      if (!rateAllowed(identity.roomId, identity.agentId)) {
        send(ws, { type: "error", id: envelope.id, error: "message rate limit exceeded" });
        await log.write("message_rate_limited", identity);
        return;
      }
      if (!room.pending.has(envelope.id) && room.pending.size >= limits.maxPendingPerRoom) {
        send(ws, { type: "error", id: envelope.id, error: "room pending queue is full" });
        await log.write("message_queue_full", identity);
        return;
      }
      envelope.queuedAt = Date.now();
      room.pending.set(envelope.id, envelope);
      room.lastActivity = Date.now();
      schedulePersist();
      await log.write("message_queued", {
        roomId: identity.roomId,
        from: identity.agentId,
        to: envelope.to || null,
        messageId: envelope.id,
        bytes: raw.length,
      });
      send(ws, { type: "message_accepted", id: envelope.id });
      const recipients = [...room.members].filter(
        (member) => member !== identity.agentId && (!envelope.to || envelope.to === member),
      );
      for (const recipientId of recipients) deliverPending(identity.roomId, recipientId);
      return;
    }

    if (message.type === "message_ack") {
      const envelope = room.pending.get(message.id);
      if (envelope && envelope.from !== identity.agentId) {
        room.pending.delete(message.id);
        room.lastActivity = Date.now();
        schedulePersist();
        await log.write("message_delivered", {
          roomId: identity.roomId,
          messageId: message.id,
          recipient: identity.agentId,
        });
        sendToAgent(identity.roomId, envelope.from, {
          type: "delivery_ack",
          id: message.id,
          recipient: identity.agentId,
        });
      }
      return;
    }

    if (message.type === "ping") send(ws, { type: "pong", at: Date.now() });
  });

  ws.on("close", async () => {
    clearTimeout(helloTimer);
    if (!identity) return;
    const key = socketKey(identity.roomId, identity.agentId);
    const agentSockets = sockets.get(key);
    agentSockets?.delete(ws);
    if (agentSockets?.size === 0) sockets.delete(key);
    await log.write("client_disconnected", identity);
    const room = rooms.get(identity.roomId);
    if (room) {
      room.lastActivity = Date.now();
      room.memberLastSeen.set(identity.agentId, Date.now());
      schedulePersist();
    }
    if (!sockets.has(key)) {
      for (const member of room?.members || []) {
        if (member === identity.agentId) continue;
        sendToAgent(identity.roomId, member, {
          type: "peer_status",
          agentId: identity.agentId,
          publicKey: room.memberKeys.get(identity.agentId),
          keyProof: room.memberProofs.get(identity.agentId),
          online: false,
        });
      }
    }
  });
});

const cleanupTimer = setInterval(async () => {
  const now = Date.now();
  let changed = false;
  for (const [roomId, room] of rooms) {
    for (const [messageId, envelope] of room.pending) {
      if (now - Number(envelope.queuedAt || now) > limits.pendingTtlMs) {
        room.pending.delete(messageId);
        changed = true;
        await log.write("pending_expired", { roomId, messageId });
      }
    }
    const hasOnlineMember = [...room.members].some((member) =>
      socketsFor(roomId, member).size > 0,
    );
    if (!hasOnlineMember && now - room.lastActivity > limits.roomTtlMs) {
      rooms.delete(roomId);
      changed = true;
      await log.write("room_expired", { roomId });
    }
  }
  if (changed) schedulePersist();
  for (const [key, window] of rateWindows) {
    if (now - window.startedAt > 2 * 60_000) rateWindows.delete(key);
  }
}, 60_000);
cleanupTimer.unref();

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`AgentLink relay listening on ws://${host}:${actualPort}/ws`);
  log.write("relay_started", { host, port: actualPort });
});

async function shutdown(signal) {
  await log.write("relay_stopping", { signal });
  clearInterval(cleanupTimer);
  for (const agentSockets of sockets.values()) {
    for (const ws of agentSockets) ws.close(1001, "server shutdown");
  }
  await flushPersist();
  await log.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
