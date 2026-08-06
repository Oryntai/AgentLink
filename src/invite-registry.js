import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-file.js";
import { createInviteCode, roomFingerprint } from "./invite-code.js";

const maxInvites = 100;
const states = new Set(["pending", "consumed", "revoked", "expired"]);

function text(value, limit) {
  if (value === null || value === undefined) return null;
  const string = String(value);
  return string ? string.slice(0, limit) : null;
}

function timestamp(value) {
  const parsed = value === null || value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// Every entry is rebuilt from an allowlist, including the nested consumedBy, so
// a hand-edited or hostile registry file cannot smuggle fields back to disk.
function publicEntry(entry = {}) {
  const consumedBy = entry.consumedBy && typeof entry.consumedBy === "object"
    ? {
      agentId: text(entry.consumedBy.agentId, 64),
      publicKeyFingerprint: text(entry.consumedBy.publicKeyFingerprint, 64),
      at: timestamp(entry.consumedBy.at),
    }
    : null;
  return {
    inviteId: text(entry.inviteId, 128),
    roomFingerprint: text(entry.roomFingerprint, 32),
    issuedAt: timestamp(entry.issuedAt),
    expiresAt: timestamp(entry.expiresAt),
    state: states.has(entry.state) ? entry.state : "revoked",
    label: text(entry.label, 64),
    consumedBy,
    revokedAt: timestamp(entry.revokedAt),
  };
}

// The registry never stores a room code, a room secret, or an invite code: it
// records only what the owner needs to decide whether an invite may still be
// used. A leaked registry file must not open a room.
export class InviteRegistry {
  constructor(filePath) {
    this.filePath = filePath;
    this.invites = [];
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      this.invites = (Array.isArray(parsed.invites) ? parsed.invites : [])
        .map(publicEntry)
        .filter((entry) => entry.inviteId && entry.expiresAt);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.invites = [];
    }
    return this;
  }

  async save() {
    await writeFileAtomic(
      this.filePath,
      `${JSON.stringify({ version: 1, invites: this.invites.map(publicEntry) }, null, 2)}\n`,
    );
  }

  find(inviteId) {
    return this.invites.find((entry) => entry.inviteId === inviteId) || null;
  }

  list({ now = Date.now() } = {}) {
    return this.invites.map((entry) => ({ ...entry, state: this.#effectiveState(entry, now) }));
  }

  #effectiveState(entry, now) {
    if (entry.state !== "pending") return entry.state;
    return Date.parse(entry.expiresAt) <= now ? "expired" : "pending";
  }

  async issue({ relayUrl, roomCode, ttlMs, label, now = Date.now() }) {
    const invite = createInviteCode({ relayUrl, roomCode, ttlMs, label, now });
    this.invites.push(publicEntry({
      inviteId: invite.inviteId,
      roomFingerprint: invite.roomFingerprint,
      issuedAt: invite.issuedAt,
      expiresAt: invite.expiresAt,
      state: "pending",
      label: invite.label,
    }));
    if (this.invites.length > maxInvites) {
      this.invites.splice(0, this.invites.length - maxInvites);
    }
    await this.save();
    return invite;
  }

  async revoke(inviteId, { now = Date.now() } = {}) {
    const entry = this.find(inviteId);
    if (!entry) throw new Error("Unknown invite");
    if (entry.state === "consumed") {
      throw new Error(
        "This invite was already used. Revoking it cannot remove the peer: rotate the room with npm run new-session.",
      );
    }
    entry.state = "revoked";
    entry.revokedAt = new Date(now).toISOString();
    await this.save();
    return publicEntry(entry);
  }

  // Decided synchronously so the bridge can rule during the peer handshake; the
  // caller persists afterwards. Redemption binds to the peer public key, not to
  // its agent id, so a reused name with a new key is still refused.
  redeemForPeer({ inviteId, agentId, publicKeyFingerprint, roomCode, now = Date.now() }) {
    const entry = this.find(inviteId);
    if (!entry) throw new Error("Invite is not known to this room owner");
    if (entry.roomFingerprint !== roomFingerprint(roomCode)) {
      throw new Error("Invite was issued for a different room");
    }
    const state = this.#effectiveState(entry, now);
    if (state === "revoked") throw new Error("Invite was revoked");
    if (state === "expired") throw new Error("Invite expired");
    if (state === "consumed") {
      if (entry.consumedBy?.publicKeyFingerprint !== publicKeyFingerprint) {
        throw new Error("Invite was already redeemed by a different key");
      }
      return { entry, changed: false, rollback: () => {} };
    }
    const previous = { state: entry.state, consumedBy: entry.consumedBy };
    entry.state = "consumed";
    entry.consumedBy = {
      agentId: agentId || null,
      publicKeyFingerprint,
      at: new Date(now).toISOString(),
    };
    return {
      entry,
      changed: true,
      // The caller must be able to undo this if the record cannot be persisted.
      rollback: () => {
        entry.state = previous.state;
        entry.consumedBy = previous.consumedBy;
      },
    };
  }

  hasPending({ roomCode, now = Date.now() } = {}) {
    const fingerprint = roomFingerprint(roomCode);
    return this.invites.some(
      (entry) => entry.roomFingerprint === fingerprint && this.#effectiveState(entry, now) === "pending",
    );
  }
}

export async function openInviteRegistry(configPath) {
  return new InviteRegistry(`${configPath}.invites.json`).load();
}
