const maxSeenMessageIds = 5_000;

function text(value, limit) {
  if (value === null || value === undefined) return null;
  const string = String(value);
  return string ? string.slice(0, limit) : null;
}

function timestamp(value) {
  const parsed = value === null || value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeBoundPeer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const agentId = text(raw.agentId, 64);
  const publicKey = text(raw.publicKey, 4_096);
  const roomId = text(raw.roomId, 128);
  if (!agentId || !publicKey || !roomId) return null;
  return {
    roomId,
    agentId,
    publicKey,
    fingerprint: text(raw.fingerprint, 64),
    verification: raw.verification === "verified" ? "verified" : "pending",
    at: timestamp(raw.at),
    verifiedAt: timestamp(raw.verifiedAt),
  };
}

export function sanitizeTrust(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const peers = {};
  for (const [agentId, publicKey] of Object.entries(source.peers || {})) {
    const name = text(agentId, 64);
    const key = text(publicKey, 4_096);
    if (name && key) peers[name] = key;
  }
  const seen = [];
  for (const id of Array.isArray(source.seenMessageIds) ? source.seenMessageIds : []) {
    const value = text(id, 128);
    if (value) seen.push(value);
  }
  return {
    peers,
    boundPeer: sanitizeBoundPeer(source.boundPeer),
    seenMessageIds: seen.slice(-maxSeenMessageIds),
  };
}

// Merges what another process already wrote with what this one holds. Trust only
// ever grows: a pinned key, a binding, or a seen message id must never be lost
// because two processes saved at the same time.
export function mergeTrust(disk, local, { roomId = null } = {}) {
  const base = sanitizeTrust(disk);
  const mine = sanitizeTrust(local);
  // Trust files are per room, so a binding for any other room is stale data and
  // must not survive the merge.
  if (roomId) {
    if (base.boundPeer && base.boundPeer.roomId !== roomId) base.boundPeer = null;
    if (mine.boundPeer && mine.boundPeer.roomId !== roomId) mine.boundPeer = null;
  }

  const peers = { ...base.peers };
  for (const [agentId, publicKey] of Object.entries(mine.peers)) {
    // A disagreement means one side is wrong; the first recorded key wins so a
    // late writer can never silently replace a pinned identity.
    if (!peers[agentId]) peers[agentId] = publicKey;
  }

  let boundPeer = base.boundPeer;
  if (!boundPeer) {
    boundPeer = mine.boundPeer;
  } else if (
    mine.boundPeer
    && mine.boundPeer.roomId === boundPeer.roomId
    && mine.boundPeer.agentId === boundPeer.agentId
    && mine.boundPeer.publicKey === boundPeer.publicKey
  ) {
    // Same binding seen by both: a completed human verification wins.
    if (mine.boundPeer.verification === "verified" && boundPeer.verification !== "verified") {
      boundPeer = { ...boundPeer, verification: "verified", verifiedAt: mine.boundPeer.verifiedAt };
    }
    boundPeer = { ...boundPeer, fingerprint: boundPeer.fingerprint || mine.boundPeer.fingerprint };
  }

  const seen = new Set(base.seenMessageIds);
  for (const id of mine.seenMessageIds) seen.add(id);
  const merged = [...seen];
  return {
    peers,
    boundPeer,
    seenMessageIds: merged.slice(-maxSeenMessageIds),
  };
}
