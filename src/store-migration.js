export const STORE_VERSION = 3;

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

export function migrateStore(raw, { maxActivity = DEFAULT_ACTIVITY_LIMIT } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const data = {
    version: STORE_VERSION,
    messages: Array.isArray(source.messages) ? source.messages : [],
    outbound: source.outbound && typeof source.outbound === "object" ? source.outbound : {},
    completed: source.completed && typeof source.completed === "object" ? source.completed : {},
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
