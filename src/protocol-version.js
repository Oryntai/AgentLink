export const BROKER_PROTOCOL_VERSION = 4;
export const DESKTOP_API_VERSION = 3;

export const MIN_BROKER_PROTOCOL_VERSION = 2;

export const MIN_CLIENT_PROTOCOL_VERSION = 2;
export const MAX_CLIENT_PROTOCOL_VERSION = BROKER_PROTOCOL_VERSION;

export const CORE_BROKER_METHODS = Object.freeze([
  "hello",
  "register",
  "takeover",
  "status",
  "send",
  "wait",
  "watch",
  "request_send",
  "request_status",
  "ask",
  "mark_processing",
  "respond",
  "inbox_list",
  "inbox_claim",
  "release",
  "discard",
]);

export const DESKTOP_BROKER_METHODS = Object.freeze([
  ...CORE_BROKER_METHODS,
  "owner_request_send",
  "activity_tail",
  "room_create",
  "room_join",
  "invite_create",
  "invite_list",
  "invite_revoke",
  "peer_verify",
  "policy_get",
  "policy_set",
  "approval_list",
  "approval_decide",
  "conversation_list",
  "transcript_list",
]);

export const BROKER_METHODS = DESKTOP_BROKER_METHODS;

export function requiredBrokerProtocol() {
  const configured = Number(process.env.AGENT_LINK_MIN_BROKER_PROTOCOL || 0);
  return Number.isFinite(configured) && configured > MIN_BROKER_PROTOCOL_VERSION
    ? configured
    : MIN_BROKER_PROTOCOL_VERSION;
}

export function brokerCompatibility(info, options = {}) {
  const {
    clientProtocol = BROKER_PROTOCOL_VERSION,
    requiredMethods = CORE_BROKER_METHODS,
  } = options;
  const required = requiredBrokerProtocol();
  if (!info || typeof info.brokerProtocol !== "number") {
    return { compatible: false, required, reason: "broker predates protocol negotiation" };
  }
  if (info.brokerProtocol < required) {
    return {
      compatible: false,
      required,
      reason: `broker protocol ${info.brokerProtocol} is older than ${required}`,
    };
  }
  const available = new Set(info.methods || []);
  const missing = requiredMethods.filter((method) => !available.has(method));
  if (missing.length) {
    return { compatible: false, required, reason: `broker is missing ${missing.join(", ")}` };
  }
  const advertisesRange = typeof info.minClientProtocol === "number"
    && typeof info.maxClientProtocol === "number";
  if (info.brokerProtocol > clientProtocol && !advertisesRange) {
    return {
      compatible: false,
      required,
      reason: `broker protocol ${info.brokerProtocol} is newer than this client `
        + `(${clientProtocol}) and does not advertise a supported client range`,
    };
  }
  if (
    advertisesRange
    && (clientProtocol < info.minClientProtocol || clientProtocol > info.maxClientProtocol)
  ) {
    return {
      compatible: false,
      required,
      reason: `broker serves client protocols ${info.minClientProtocol}-${info.maxClientProtocol}, `
        + `not ${clientProtocol}`,
    };
  }
  return { compatible: true, required, reason: null };
}
