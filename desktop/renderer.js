const escape = (value) => String(value ?? "—").replace(
  /[<>&]/g,
  (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[character]),
);

const time = (value) => value
  ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  : "—";
const date = (value) => value
  ? new Date(value).toLocaleDateString([], { day: "numeric", month: "short" })
  : "—";
const initials = (value) => String(value || "?")
  .split(/[\s:_-]+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0])
  .join("")
  .toUpperCase() || "?";

const outboundLabels = {
  queued_local: "Sending…",
  relay_acked: "Sent to relay",
  sent: "Sent to relay",
  delivered: "Delivered",
  queued: "Delivered · waiting for agent",
  held: "Delivered · waiting for approval",
  claimed: "Read by their agent",
  processing: "Read · their agent is working",
  responded: "Read · answered",
  read: "Read by their agent",
  declined: "Declined",
  expired: "Expired",
};

const inboundLabels = {
  unread: "Not read by your agent",
  queued: "Waiting for your agent",
  held: "Waiting for your approval",
  claimed: "Read by your agent",
  processing: "Your agent is working",
  responded: "Your agent replied",
  read: "Read by your agent",
  delivered: "Delivered",
  declined: "Declined",
  expired: "Expired",
};

const localAgentLabels = {
  unread: "Unread",
  queued: "Waiting for agent",
  held: "Waiting for approval",
  claimed: "Read",
  processing: "Working",
  responded: "Read · answered",
  read: "Read",
  delivered: "Delivered",
  declined: "Declined",
  expired: "Expired",
};

const transcript = new Map();
let transcriptCursor = null;
let transcriptRoomId = null;
let transcriptLoadedOlder = false;
let activeMode = null;

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function rows(target, pairs) {
  document.getElementById(target).innerHTML = pairs
    .map(([key, value]) => `<div class="row"><span class="k">${key}</span><span class="v">${value}</span></div>`)
    .join("");
}

function setComposerEnabled(enabled) {
  document.getElementById("question").disabled = !enabled;
  document.getElementById("send-question").disabled = !enabled;
  document.getElementById("stop-dialogue").disabled = !enabled;
  document.getElementById("owner-recipient").disabled = !enabled;
  document.getElementById("owner-recipient-trigger").disabled = !enabled;
}

function setOwnerRecipientVisible(visible) {
  const picker = document.getElementById("owner-recipient-picker");
  const stop = document.getElementById("stop-dialogue");
  picker.hidden = !visible;
  picker.classList.toggle("hidden", !visible);
  stop.hidden = !visible;
  stop.classList.toggle("hidden", !visible);
  if (!visible) {
    document.getElementById("owner-recipient-menu").classList.add("hidden");
    document.getElementById("owner-recipient-trigger").setAttribute("aria-expanded", "false");
  }
  document.getElementById("send-question").textContent = visible ? "Send to agents" : "Send";
}

function statusFor(message) {
  if (message.kind === "owner_response") return "Reply to owner";
  const labels = activeMode === "local_duo" && message.direction !== "outbound"
    ? localAgentLabels
    : message.direction === "outbound" ? outboundLabels : inboundLabels;
  const label = labels[message.state] || message.state || "Recorded";
  return message.reason ? `${label} · ${message.reason}` : label;
}

function receiptClass(message) {
  if (["read", "claimed", "processing", "responded"].includes(message.state)) return "read";
  if (["declined", "expired"].includes(message.state)) return "problem";
  return "";
}

function kindFor(message) {
  const labels = {
    request: "Request",
    response: "Answer",
    owner_request: "Owner instruction",
    owner_response: "Answer to owner",
    general: "Message",
    goal_proposal: "Goal",
    goal_response: "Goal reply",
    completion: "Complete",
  };
  return labels[message.kind] || String(message.kind || "message").replace(/_/g, " ");
}

function mergeTranscript(page, { preserveCursor = false } = {}) {
  for (const message of page?.messages || []) transcript.set(message.id, message);
  if (page && Object.hasOwn(page, "nextBefore") && !preserveCursor) {
    transcriptCursor = page.nextBefore;
  }
}

function dayKey(value) {
  const when = new Date(value);
  return `${when.getFullYear()}-${when.getMonth()}-${when.getDate()}`;
}

function renderTranscript() {
  const node = document.getElementById("transcript");
  const timeline = document.getElementById("timeline");
  const previousScrollTop = timeline.scrollTop;
  const distanceFromBottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
  const stickToBottom = node.dataset.rendered !== "true" || distanceFromBottom < 80;
  const older = document.getElementById("load-older");
  const messages = [...transcript.values()].sort((left, right) =>
    new Date(left.createdAt) - new Date(right.createdAt) || left.id.localeCompare(right.id));
  older.hidden = !transcriptCursor;
  older.disabled = !transcriptCursor;

  if (!messages.length) {
    node.innerHTML = `<div class="empty-chat"><strong>No messages yet</strong>Once both local agents are connected, their encrypted conversation appears here.</div>`;
    node.dataset.rendered = "true";
    return;
  }

  let previousDay = null;
  node.innerHTML = messages.map((message) => {
    const currentDay = dayKey(message.createdAt);
    const divider = currentDay === previousDay
      ? ""
      : `<div class="day-divider">${escape(date(message.createdAt))}</div>`;
    previousDay = currentDay;
    const outgoing = message.direction === "outbound";
    return `${divider}<article class="message ${outgoing ? "outgoing" : "incoming"}">`
      + `<div class="avatar">${escape(initials(message.author))}</div>`
      + `<div class="bubble"><div class="message-meta"><strong>${escape(message.author)}</strong>`
      + `<span class="message-kind">${escape(kindFor(message))}</span><span>${escape(time(message.createdAt))}</span></div>`
      + `<div class="message-body">${escape(message.text)}</div>`
      + `<div class="message-footer"><div class="receipt ${receiptClass(message)}">${outgoing ? "✓ " : ""}${escape(statusFor(message))}</div>`
      + `<button class="copy-message" type="button" data-copy-message="${escape(message.id)}" aria-label="Copy message" title="Copy message">`
      + '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.5"></rect><path d="M3 10V4.5A1.5 1.5 0 0 1 4.5 3H10"></path></svg></button></div>'
      + "</div></article>";
  }).join("");
  for (const button of node.querySelectorAll("[data-copy-message]")) {
    button.addEventListener("click", async (event) => {
      const entry = transcript.get(event.currentTarget.dataset.copyMessage);
      if (!entry) return;
      await navigator.clipboard.writeText(entry.text);
      const control = event.currentTarget;
      control.classList.add("copied");
      control.setAttribute("aria-label", "Copied");
      control.title = "Copied";
      setTimeout(() => {
        control.classList.remove("copied");
        control.setAttribute("aria-label", "Copy message");
        control.title = "Copy message";
      }, 1_200);
    });
  }
  node.dataset.rendered = "true";
  requestAnimationFrame(() => {
    timeline.scrollTop = stickToBottom ? timeline.scrollHeight : previousScrollTop;
  });
}

function renderParticipant(target, { name, detail, online = false, peer = false }) {
  document.getElementById(target).innerHTML = `<div class="avatar">${escape(initials(name))}</div>`
    + `<div class="agent-copy"><strong>${escape(name)}</strong><span><i class="status-dot ${online ? "online" : ""}"></i>${escape(detail)}</span></div>`
    + (peer ? "" : '<span class="small">you</span>');
}

function newestPreview() {
  const newest = [...transcript.values()].sort((left, right) =>
    new Date(right.createdAt) - new Date(left.createdAt))[0];
  if (!newest) return null;
  const speaker = activeMode === "local_duo"
    ? newest.direction === "outbound" ? "You" : newest.author
    : newest.direction === "outbound" ? "You" : "Peer";
  return `${speaker}: ${newest.text}`;
}

function renderRoom(status) {
  const peer = status.peer;
  const roomName = status.roomName || "No active room";
  const connected = Boolean(status.connected);
  const preview = newestPreview() || (peer
    ? "Waiting for the next message"
    : "Create or join a room to connect a peer.");
  setText("room-title", roomName);
  setText("chat-title", peer?.agentId || roomName);
  setText("room-preview", preview);
  setText("room-time", status.queuedMessages ? `${status.queuedMessages} queued` : "");
  setText("chat-subtitle", peer
    ? `${status.peerOnline ? "Online" : "Offline"} · encrypted room ${status.roomId || "—"}`
    : "Connect a trusted peer agent to begin.");
  setText("room-avatar", initials(roomName));
  setText("peer-avatar", initials(peer?.agentId || roomName));

  const badge = document.getElementById("link");
  badge.className = `pill ${connected ? "ok" : "warn"}`;
  badge.textContent = connected ? "● Connected" : "● Offline";

  renderParticipant("local-agent", {
    name: status.agentId || "Local agent",
    detail: `${status.role || "agent"} · this device`,
    online: connected,
  });
  renderParticipant("peer-agent", {
    name: peer?.agentId || "No peer connected",
    detail: peer ? `${status.peerOnline ? "online" : "offline"} · ${peer.verification || "unverified"}` : "share an invite to connect",
    online: Boolean(status.peerOnline),
    peer: true,
  });

  rows("link-rows", [
    ["relay", connected ? "connected" : "disconnected"],
    ["room", escape(status.roomId || "—")],
    ["local role", escape(status.role || "—")],
    ["queued", escape(status.queuedMessages ?? 0)],
  ]);
  rows("peer-rows", peer
    ? [
      ["fingerprint", escape(peer.fingerprint || "—")],
      ["verified", `<span class="pill ${peer.verification === "verified" ? "ok" : "warn"}">${escape(peer.verification || "unverified")}</span>`],
      ["bound", escape(time(peer.boundAt))],
    ]
    : [["peer", "not connected"]]);

  const verify = document.getElementById("verify-peer");
  verify.disabled = !peer || peer.verification === "verified";
  verify.textContent = peer?.verification === "verified" ? "Fingerprint verified" : "Verify fingerprint";
}

function renderApprovals(policy, waiting) {
  const manual = policy.approvals === "manual";
  rows("policy-rows", [
    ["mode", manual ? "manual approval" : "agent decides"],
    ["waiting", escape(policy.waiting ?? 0)],
  ]);
  const toggle = document.getElementById("toggle-policy");
  toggle.textContent = manual ? "Let agent decide" : "Approve each request";
  toggle.dataset.next = manual ? "auto" : "manual";
  document.getElementById("approvals").innerHTML = waiting.length
    ? waiting.map((record) => `<div class="request"><div class="request-meta">${escape(record.from)} · ${escape(time(record.receivedAt))}</div>`
      + `<p>${escape(record.question)}</p><div class="request-actions"><button class="primary" data-approve="${escape(record.requestId)}">Approve</button>`
      + `<button class="danger" data-deny="${escape(record.requestId)}">Deny</button></div></div>`).join("")
    : `<div class="list-item">${manual ? "Nothing is waiting for your decision." : "Your agent handles incoming requests itself."}</div>`;

  for (const button of document.querySelectorAll("[data-approve]")) {
    button.addEventListener("click", (event) => {
      void run(event.currentTarget, "decide", {
        requestId: event.currentTarget.dataset.approve,
        decision: "approve",
      }, () => say("Approved. Your agent may claim the request now.", "ok", "policy-msg"), "policy-msg");
    });
  }
  for (const button of document.querySelectorAll("[data-deny]")) {
    button.addEventListener("click", (event) => {
      void run(event.currentTarget, "decide", {
        requestId: event.currentTarget.dataset.deny,
        decision: "deny",
      }, () => say("Denied. The peer receives no reason.", "ok", "policy-msg"), "policy-msg");
    });
  }
}

function renderInvites(invites) {
  document.getElementById("invites").innerHTML = invites.length
    ? invites.map((record) => `<div class="list-item"><strong>${escape(record.label || "Peer invitation")}</strong>`
      + `${escape(record.state)} · expires ${escape(time(record.expiresAt))}`
      + (record.state === "pending" ? `<button class="secondary" data-revoke="${escape(record.inviteId)}">Revoke</button>` : "")
      + "</div>").join("")
    : '<div class="list-item">No invitations yet.</div>';
  for (const button of document.querySelectorAll("[data-revoke]")) {
    button.addEventListener("click", (event) => {
      void run(event.currentTarget, "revokeInvite", { inviteId: event.currentTarget.dataset.revoke }, () =>
        say("Invitation revoked.", "ok"));
    });
  }
}

function renderMetadataList(target, records, render, empty) {
  document.getElementById(target).innerHTML = records.length
    ? records.map((record) => `<div class="list-item">${render(record)}</div>`).join("")
    : `<div class="list-item">${empty}</div>`;
}

function localDuoPrompt(profile) {
  return [
    `You are ${profile.displayName}, the ${profile.role === "initiator" ? "builder" : "reviewer"} in the owner's Local Duo.`,
    `First call peer_local_duo_claim with profile_id "${profile.id}".`,
    "Then use $agentlink-messenger: check status and inbox, communicate with the peer deliberately, and keep serving requests.",
    "This is a dedicated live-messenger task: do not finish after replying. Keep peer_listen pending with timeout_seconds 86400; after every peer_respond, timeout, or recoverable error, check the inbox and immediately call peer_listen again.",
    `Work only in this workspace unless the owner explicitly expands scope: ${profile.workspace}`,
  ].join("\n");
}

function renderLocalDuoControls(duo) {
  const node = document.getElementById("duo-agents");
  const prompts = document.getElementById("duo-prompts");
  if (!duo) {
    node.innerHTML = '<div class="list-item">Create the pair once, then open two Codex tasks and give each its profile prompt.</div>';
    prompts.innerHTML = "";
    prompts.hidden = true;
    return;
  }
  node.innerHTML = duo.profiles.map((profile) => {
    // A broker can be connected before any Codex task has claimed this identity.
    // Keep that profile visibly waiting until the claim has armed an agent.
    const active = Boolean(profile.claim && profile.status?.connected && !profile.error);
    const availability = profile.error
      ? `error · ${profile.error}`
      : active ? "active in a Codex task"
        : profile.claim ? "claimed · starting agent"
          : "waiting for this task to claim its profile";
    return `<div class="list-item"><strong><span class="status-dot ${active ? "online" : "waiting"}"></span>${escape(profile.displayName)}</strong>`
      + `${escape(profile.role)} · ${escape(availability)}<br><span class="small">${escape(profile.workspace)}</span></div>`;
  }).join("");
  prompts.hidden = false;
  prompts.innerHTML = '<div class="list-item"><strong>Launch two separate Codex tasks</strong>'
    + 'Copy one prompt into each new task. A profile becomes active only after that task claims it.</div>'
    + duo.profiles.map((profile, index) => `<div class="field"><label>Step ${index + 1} · ${escape(profile.displayName)} task prompt</label>`
      + `<button class="secondary" data-copy-duo="${escape(profile.id)}">Copy ${escape(profile.displayName)} launch prompt</button></div>`).join("");
  for (const button of prompts.querySelectorAll("[data-copy-duo]")) {
    button.addEventListener("click", async (event) => {
      const profile = duo.profiles.find((entry) => entry.id === event.currentTarget.dataset.copyDuo);
      await navigator.clipboard.writeText(localDuoPrompt(profile));
      say(`${profile.displayName} prompt copied. Paste it into that Codex task once.`, "ok", "duo-msg");
    });
  }
}

function renderLocalDuo(duo) {
  activeMode = "local_duo";
  renderLocalDuoControls(duo);
  const developer = duo.profiles.find((profile) => profile.id === "developer") || duo.profiles[0];
  const reviewer = duo.profiles.find((profile) => profile.id === "reviewer") || duo.profiles[1];
  const roomId = developer?.status?.roomId || reviewer?.status?.roomId || "local-duo";
  if (`local-duo:${roomId}` !== transcriptRoomId) {
    transcriptRoomId = `local-duo:${roomId}`;
    transcript.clear();
    transcriptCursor = null;
    transcriptLoadedOlder = false;
  }
  mergeTranscript({ messages: duo.messages || [], nextBefore: null });
  document.getElementById("load-older").hidden = true;
  setComposerEnabled(true);
  setOwnerRecipientVisible(true);
  document.getElementById("question").placeholder = "Write an instruction or question to the agents…";
  say("Send an encrypted local instruction to Developer, Reviewer, or both. Their replies appear here.", "", "ask-msg");
  const claimedCount = duo.profiles.filter((profile) => profile.claim).length;
  const brokersOnline = duo.profiles.every((profile) => profile.status?.connected);
  const online = brokersOnline && claimedCount === 2;
  setText("room-title", duo.roomName);
  setText("room-preview", online ? "Two local agent identities are linked" : "Waiting for both Codex agent profiles");
  setText("room-time", `${claimedCount}/2 claimed`);
  setText("room-avatar", "2A");
  setText("chat-title", `${developer?.displayName || "Developer"} ↔ ${reviewer?.displayName || "Reviewer"}`);
  setText("chat-subtitle", `Local encrypted relay · ${duo.relayUrl}`);
  setText("peer-avatar", "2A");
  const badge = document.getElementById("link");
  badge.className = `pill ${online ? "ok" : "warn"}`;
  badge.textContent = online ? "● Duo online" : "● Waiting for agents";
  renderParticipant("local-agent", {
    name: developer?.displayName || "Developer",
    detail: `${developer?.claim ? "claimed" : "waiting"} · ${developer?.role || "initiator"}`,
    online: Boolean(developer?.status?.connected && developer?.claim),
    peer: true,
  });
  renderParticipant("peer-agent", {
    name: reviewer?.displayName || "Reviewer",
    detail: `${reviewer?.claim ? "claimed" : "waiting"} · ${reviewer?.role || "responder"}`,
    online: Boolean(reviewer?.status?.connected && reviewer?.claim),
    peer: true,
  });
  rows("link-rows", [
    ["mode", "two local agents"],
    ["relay", "127.0.0.1 only"],
    ["room", escape(roomId)],
    ["tasks", `${claimedCount}/2 claimed`],
  ]);
  rows("peer-rows", [
    ["builder", escape(developer?.claim ? "task claimed" : "waiting")],
    ["reviewer", escape(reviewer?.claim ? "task claimed" : "waiting")],
  ]);
  const verify = document.getElementById("verify-peer");
  verify.disabled = true;
  verify.textContent = "Local profiles use separate keys";
  rows("policy-rows", [["policy", "each profile follows its own agent safety rules"]]);
  document.getElementById("approvals").innerHTML = '<div class="list-item">No messages are exposed to the other profile before its own agent claims them.</div>';
  document.getElementById("toggle-policy").disabled = true;
  document.getElementById("toggle-policy").textContent = "Local Duo manages its own profiles";
  renderInvites([]);
  renderMetadataList("inbox", [], () => "", "Each profile has its own private inbox.");
  renderMetadataList("activity", [], () => "", "Metadata stays inside each profile broker.");
  renderTranscript();
}

function say(text, kind = "", target = "room-msg") {
  const node = document.getElementById(target);
  node.className = `compose-note ${kind}`;
  node.textContent = text;
}

async function refresh() {
  const state = await window.agentlink.state();
  if (state.ok && state.mode === "local_duo") {
    renderLocalDuo(state.localDuo);
    return;
  }
  renderLocalDuoControls(null);
  if (!state.ok) {
    activeMode = null;
    setComposerEnabled(false);
    setOwnerRecipientVisible(false);
    const badge = document.getElementById("link");
    badge.className = "pill bad";
    badge.textContent = "● Broker unavailable";
    setText("room-title", "No active room");
    setText("chat-title", "Set up AgentLink first");
    setText("chat-subtitle", "The desktop app needs an active AgentLink room configuration.");
    setText("room-preview", "Host or join a room, then reopen this window.");
    document.getElementById("transcript").innerHTML = `<div class="empty-chat"><strong>Connect a room first</strong>${escape(state.error)}</div>`;
    rows("link-rows", [["status", escape(state.error)]]);
    rows("peer-rows", [["peer", "unknown"]]);
    renderParticipant("local-agent", { name: "Local agent", detail: "not connected" });
    renderParticipant("peer-agent", { name: "No peer connected", detail: "share an invite to connect", peer: true });
    return;
  }

  activeMode = "remote";
  setComposerEnabled(true);
  setOwnerRecipientVisible(false);
  document.getElementById("question").placeholder = "Ask the peer agent a question…";
  const status = state.status || {};
  if (status.roomId !== transcriptRoomId) {
    transcriptRoomId = status.roomId;
    transcript.clear();
    transcriptCursor = null;
    transcriptLoadedOlder = false;
  }
  mergeTranscript(state.transcript, { preserveCursor: transcriptLoadedOlder });
  renderRoom(status);
  renderTranscript();
  renderApprovals(state.policy || { approvals: "auto", waiting: 0 }, state.waiting || []);
  renderInvites(state.invites || []);
  renderMetadataList("inbox", state.inbox || [], (record) => `<strong>${escape(record.from)}</strong>${escape(record.state)} · ${escape(time(record.receivedAt))}`, "No incoming requests.");
  renderMetadataList("activity", (state.activity || []).slice().reverse(), (record) => `<strong>${escape(record.messageKind || record.kind)}</strong>${escape(record.state)} · ${escape(time(record.ts))}`, "Metadata-only activity will appear here.");
}

async function run(button, name, payload, onDone, target = "room-msg") {
  button.disabled = true;
  say("Working…", "", target);
  const answer = await window.agentlink.act(name, payload);
  button.disabled = false;
  if (!answer.ok) {
    say(answer.error, "bad", target);
    return;
  }
  onDone(answer.result);
  await refresh();
}

document.getElementById("create-room").addEventListener("click", (event) => {
  const name = document.getElementById("room-name").value.trim();
  if (!name) return say("Give the room a name first.", "bad");
  void run(event.currentTarget, "createRoom", { name }, (result) => {
    say(`Room “${result.roomName}” is ready. The local agents switch automatically.`, "ok");
  });
});

document.getElementById("join-room").addEventListener("click", (event) => {
  const invite = document.getElementById("invite-input").value.trim();
  if (!invite) return say("Paste a single-use invite first.", "bad");
  const displayName = document.getElementById("join-name").value.trim();
  void run(event.currentTarget, "joinRoom", { invite, displayName }, (result) => {
    document.getElementById("invite-input").value = "";
    say(result.isNewCodexConnection
      ? `Joined “${result.roomName || "room"}”. Codex connection and AgentLink skill are ready; restart Codex once.`
      : `Joined “${result.roomName || "room"}”. The local agents switch automatically.`, "ok");
  });
});

document.getElementById("create-local-duo").addEventListener("click", (event) => {
  const payload = {
    roomName: document.getElementById("local-room-name").value.trim(),
    developerName: document.getElementById("developer-name").value.trim(),
    developerWorkspace: document.getElementById("developer-workspace").value.trim(),
    reviewerName: document.getElementById("reviewer-name").value.trim(),
    reviewerWorkspace: document.getElementById("reviewer-workspace").value.trim(),
  };
  void run(event.currentTarget, "createLocalDuo", payload, () => {
    say("Local Duo is ready. Restart Codex once, then copy each launch prompt into a different new task. A task becomes active after it claims its profile.", "ok", "duo-msg");
  }, "duo-msg");
});

const recipientTrigger = document.getElementById("owner-recipient-trigger");
const recipientMenu = document.getElementById("owner-recipient-menu");
const recipientPicker = document.getElementById("owner-recipient-picker");

function closeRecipientMenu() {
  recipientMenu.classList.add("hidden");
  recipientTrigger.setAttribute("aria-expanded", "false");
}

recipientTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  const opening = recipientMenu.classList.contains("hidden");
  recipientMenu.classList.toggle("hidden", !opening);
  recipientTrigger.setAttribute("aria-expanded", String(opening));
});

for (const option of recipientMenu.querySelectorAll("[data-recipient]")) {
  option.addEventListener("click", () => {
    document.getElementById("owner-recipient").value = option.dataset.recipient;
    recipientTrigger.textContent = `${option.textContent} ↑`;
    for (const item of recipientMenu.querySelectorAll("[data-recipient]")) {
      item.classList.toggle("selected", item === option);
    }
    closeRecipientMenu();
    document.getElementById("question").focus();
  });
}

document.addEventListener("click", (event) => {
  if (!recipientPicker.contains(event.target)) closeRecipientMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeRecipientMenu();
});

document.getElementById("send-question").addEventListener("click", (event) => {
  const field = document.getElementById("question");
  const question = field.value.trim();
  if (!question) return say("Type a message first.", "bad", "ask-msg");
  const localDuo = activeMode === "local_duo";
  const payload = localDuo
    ? { question, recipient: document.getElementById("owner-recipient").value }
    : { question };
  void run(event.currentTarget, localDuo ? "ownerAskLocalDuo" : "ask", payload, (result) => {
    field.value = "";
    const recipients = result?.deliveries?.map((item) => item.displayName).join(" and ");
    say(localDuo
      ? `Instruction queued for ${recipients || "the selected agent"}. Its read and answer status update in the chat.`
      : "Encrypted request sent. Delivery and read status update in the chat.", "ok", "ask-msg");
  }, "ask-msg");
});

document.getElementById("stop-dialogue").addEventListener("click", (event) => {
  void run(event.currentTarget, "stopLocalDuo", {}, (result) => {
    const recipients = result?.deliveries?.map((item) => item.displayName).join(" and ");
    say(`Stop instruction queued for ${recipients || "both agents"}. They remain online for your next task.`, "ok", "ask-msg");
  }, "ask-msg");
});

document.getElementById("question").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    document.getElementById("send-question").click();
  }
});

document.getElementById("load-older").addEventListener("click", async (event) => {
  if (!transcriptCursor) return;
  event.currentTarget.disabled = true;
  const answer = await window.agentlink.transcript({ before: transcriptCursor, limit: 100 });
  if (!answer.ok) {
    say(answer.error, "bad", "ask-msg");
    event.currentTarget.disabled = false;
    return;
  }
  transcriptLoadedOlder = true;
  mergeTranscript(answer.result);
  renderTranscript();
});

document.getElementById("toggle-policy").addEventListener("click", (event) => {
  const next = event.currentTarget.dataset.next === "manual" ? "manual" : "auto";
  void run(event.currentTarget, "setPolicy", { approvals: next }, (result) => {
    say(next === "manual"
      ? "Each incoming request now waits for your approval."
      : `Your agent can respond directly.${result.released ? ` Released ${result.released} waiting request(s).` : ""}`,
    "ok", "policy-msg");
  }, "policy-msg");
});

document.getElementById("create-invite").addEventListener("click", (event) => {
  void run(event.currentTarget, "createInvite", {}, (result) => {
    const code = document.getElementById("invite-code");
    code.hidden = false;
    code.textContent = result.code;
    const brief = document.getElementById("invite-brief");
    brief.hidden = !result.instructions;
    brief.textContent = result.instructions || "";
    document.getElementById("brief-actions").hidden = !result.instructions;
    say(`Single-use invite created; it expires at ${time(result.expiresAt)}.`, "ok");
  });
});

document.getElementById("copy-brief").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.getElementById("invite-brief").textContent);
  say("Peer briefing copied. Give it to the other owner's agent.", "ok");
});

document.getElementById("verify-peer").addEventListener("click", (event) => {
  void run(event.currentTarget, "verifyPeer", {}, () => say("Peer fingerprint verified.", "ok"));
});

void refresh();
setInterval(() => void refresh(), 2000);
