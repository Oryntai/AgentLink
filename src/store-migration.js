export const STORE_VERSION = 4;

// How a request that arrives from the peer reaches this owner's agent.
// "auto" is what every earlier version did: the request is queued for whichever
// task is listening. "manual" holds it until the owner approves it in the
// desktop window, which is what makes it safe to hand an invite to a guest.
export const APPROVAL_MODES = Object.freeze(["auto", "manual"]);
export const DEFAULT_APPROVAL_MODE = "auto";

export function approvalMode(raw) {
  return APPROVAL_MODES.includes(raw) ? raw : DEFAULT_APPROVAL_MODE;
}

const maxKindLength = 40;
const maxIdLength = 128;
const maxPeerLength = 64;
const maxStateLength = 32;
const maxReasonLength = 120;
const maxTranscriptIdLength = 256;
const transcriptDirections = new Set(["inbound", "outbound"]);

export const DEFAULT_ACTIVITY_LIMIT = 500;
const minActivityLimit = 10;
const maxActivityLimit = 10_000;

function trimmed(value, limit) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text.slice(0, limit) : null;
}

function safeTimestamp(value) {
  const parsed = value === null || value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export function activityLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(Math.max(Math.floor(value), minActivityLimit), maxActivityLimit);
}

export function activityRecord({ ts, kind, messageKind, requestId, peer, state, reason } = {}) {
  if (!kind) return null;
  return {
    ts: safeTimestamp(ts),
    kind: trimmed(kind, maxKindLength),
    messageKind: trimmed(messageKind, maxKindLength),
    requestId: trimmed(requestId, maxIdLength),
    peer: trimmed(peer, maxPeerLength),
    state: trimmed(state, maxStateLength),
    reason: trimmed(reason, maxReasonLength),
  };
}

export function recordActivity(data, event, maxEntries) {
  const entry = activityRecord(event);
  if (!entry) return null;
  data.activity ||= [];
  data.activity.push(entry);
  if (data.activity.length > maxEntries) {
    data.activity.splice(0, data.activity.length - maxEntries);
  }
  return entry;
}

// Unlike the activity ring, the transcript intentionally retains message text
// for the local owner. The broker store encrypts it at rest; this helper keeps
// it separate from the metadata-only activity records and never truncates a
// conversation body.
export function transcriptRecord({
  id,
  messageId,
  requestId,
  direction,
  kind,
  author,
  text,
  state,
  reason,
  createdAt,
  updatedAt,
} = {}) {
  const stableId = trimmed(id, maxTranscriptIdLength);
  if (!stableId || !transcriptDirections.has(direction) || typeof text !== "string") return null;
  const created = safeTimestamp(createdAt);
  return {
    id: stableId,
    messageId: trimmed(messageId, maxIdLength),
    requestId: trimmed(requestId, maxIdLength),
    direction,
    kind: trimmed(kind, maxKindLength) || "chat",
    author: trimmed(author, maxPeerLength) || "Unknown agent",
    text,
    state: trimmed(state, maxStateLength),
    reason: trimmed(reason, maxReasonLength),
    createdAt: created,
    updatedAt: safeTimestamp(updatedAt || created),
  };
}

// Transcript entries are immutable messages with mutable delivery state. This
// lets a receipt update the original bubble without ever putting its text in
// the activity ring or an ordinary log.
export function recordTranscript(data, event) {
  const stableId = trimmed(event?.id, maxTranscriptIdLength);
  if (!stableId) return null;
  data.transcript ||= [];
  const index = data.transcript.findIndex((entry) => entry.id === stableId);
  if (index < 0) {
    const entry = transcriptRecord(event);
    if (!entry) return null;
    data.transcript.push(entry);
    return entry;
  }

  const existing = data.transcript[index];
  const merged = { ...existing };
  for (const key of [
    "messageId",
    "requestId",
    "direction",
    "kind",
    "author",
    "text",
    "state",
    "reason",
    "updatedAt",
  ]) {
    if (event[key] !== undefined) merged[key] = event[key];
  }
  const updated = transcriptRecord(merged);
  if (!updated) return null;
  data.transcript[index] = updated;
  return updated;
}

export function migrateStore(raw, { maxActivity = DEFAULT_ACTIVITY_LIMIT } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const data = {
    version: STORE_VERSION,
    messages: Array.isArray(source.messages) ? source.messages : [],
    outbound: source.outbound && typeof source.outbound === "object" ? source.outbound : {},
    completed: source.completed && typeof source.completed === "object" ? source.completed : {},
    // Conversation text is owner-visible only through the desktop broker API.
    // It is encrypted with the rest of this store and deliberately distinct
    // from the bounded metadata-only activity ring below.
    transcript: (Array.isArray(source.transcript) ? source.transcript : [])
      .map((entry) => transcriptRecord(entry))
      .filter(Boolean),
    // Rebuilt field by field so an entry written by another build can never
    // smuggle request text into the metadata-only activity ring.
    activity: (Array.isArray(source.activity) ? source.activity : [])
      .map((entry) => activityRecord(entry))
      .filter(Boolean),
    // Rebuilt rather than carried over, so an unknown mode written by another
    // build can never disable the approval gate by accident.
    policy: { approvals: approvalMode(source.policy?.approvals) },
  };
  if (data.activity.length > maxActivity) {
    data.activity.splice(0, data.activity.length - maxActivity);
  }
  return data;
}
