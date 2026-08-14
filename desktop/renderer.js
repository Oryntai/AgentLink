const escape = (value) => String(value ?? "—").replace(
  /[<>&]/g,
  (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[character]),
);
const time = (value) => (value ? new Date(value).toLocaleTimeString() : "—");

// What an outbound question is doing right now, said the way a person would.
const outboundLabels = {
  queued_local: "Not delivered yet.",
  relay_acked: "Delivered to the relay.",
  queued: "Waiting for their agent to pick it up.",
  held: "Waiting for the other owner to approve it.",
  claimed: "Their agent picked it up.",
  processing: "Their agent is working on it.",
  expired: "Expired before an answer arrived.",
};

function rows(target, pairs) {
  document.getElementById(target).innerHTML = pairs
    .map(([key, value]) => `<div class="row"><span class="k">${key}</span><span class="v">${value}</span></div>`)
    .join("");
}

function table(target, columns, records, render) {
  const node = document.getElementById(target);
  if (!records.length) {
    node.innerHTML = '<div class="empty">Nothing here yet.</div>';
    return;
  }
  node.innerHTML = `<table><thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}`
    + `</tr></thead><tbody>${records.map(render).join("")}</tbody></table>`;
}

async function refresh() {
  const state = await window.agentlink.state();
  const badge = document.getElementById("link");
  document.getElementById("config").textContent = state.configPath || "";

  if (!state.ok) {
    badge.className = "pill bad";
    badge.textContent = "broker unavailable";
    rows("link-rows", [["error", escape(state.error)]]);
    rows("peer-rows", [["status", "unknown"]]);
    return;
  }

  const status = state.status || {};
  badge.className = `pill ${status.connected ? "ok" : "bad"}`;
  badge.textContent = status.connected ? "connected" : "offline";
  rows("link-rows", [
    ["relay", status.connected ? "connected" : "disconnected"],
    ["name", escape(status.roomName || "unnamed")],
    ["room", escape(status.roomId)],
    ["this agent", `${escape(status.agentId)} (${escape(status.role)})`],
    ["frontends", escape(status.frontends)],
    ["queued messages", escape(status.queuedMessages)],
  ]);

  const peer = status.peer;
  rows("peer-rows", peer
    ? [
      ["agent", escape(peer.agentId)],
      ["online", status.peerOnline ? "yes" : "no"],
      ["key fingerprint", escape(peer.fingerprint)],
      ["verification", `<span class="pill ${peer.verification === "verified" ? "ok" : "warn"}">`
        + `${escape(peer.verification)}</span>`],
      ["bound at", time(peer.boundAt)],
    ]
    : [["status", "no peer bound to this room yet"]]);

  const verify = document.getElementById("verify-peer");
  verify.disabled = !peer || peer.verification === "verified";
  verify.textContent = peer?.verification === "verified"
    ? "Fingerprint confirmed"
    : "Confirm this fingerprint";

  // Questions this owner asked from this window, newest first.
  const conversations = (state.conversations || []).slice().reverse();
  document.getElementById("conversations").innerHTML = conversations.length
    ? conversations.map((record) => {
      const answered = record.state === "responded";
      const pending = answered ? "" : " pending";
      const body = answered
        ? record.answer
        : record.reason || outboundLabels[record.state] || record.state;
      return '<div class="talk">'
        + `<div class="meta">${escape(answered ? "answered" : record.state.replace(/_/g, " "))}`
        + ` · ${time(record.updatedAt || record.createdAt)}</div>`
        + `<div class="said">${escape(record.question)}</div>`
        + `<div class="answer${pending}">${escape(body)}</div>`
        + "</div>";
    }).join("")
    : '<div class="empty">No questions asked from this window yet.</div>';

  // What the peer wants this owner's agent to do, and whether it needs a decision.
  const policy = state.policy || { approvals: "auto", waiting: 0 };
  const manual = policy.approvals === "manual";
  rows("policy-rows", [
    ["mode", manual ? "each request waits for your approval" : "your agent answers on its own"],
    ["waiting for you", escape(policy.waiting ?? 0)],
  ]);
  const toggle = document.getElementById("toggle-policy");
  toggle.textContent = manual ? "Let my agent answer without me" : "Approve each request myself";
  toggle.dataset.next = manual ? "auto" : "manual";

  const waiting = state.waiting || [];
  document.getElementById("approvals").innerHTML = waiting.length
    ? waiting.map((record) => '<div class="talk">'
      + `<div class="meta">${escape(record.from)} · ${time(record.receivedAt)}</div>`
      + `<div class="said">${escape(record.question)}</div>`
      + '<div class="decide">'
      + `<button data-approve="${escape(record.requestId)}">Approve</button>`
      + `<button data-deny="${escape(record.requestId)}">Deny</button>`
      + "</div></div>").join("")
    : `<div class="empty">${manual
      ? "Nothing is waiting for your decision."
      : "Requests are not held; your agent handles them directly."}</div>`;

  for (const button of document.querySelectorAll("[data-approve]")) {
    button.addEventListener("click", (event) => {
      void run(event.target, "decide", {
        requestId: event.target.dataset.approve,
        decision: "approve",
      }, () => say("Approved. Your agent can claim it now.", "ok", "policy-msg"), "policy-msg");
    });
  }
  for (const button of document.querySelectorAll("[data-deny]")) {
    button.addEventListener("click", (event) => {
      void run(event.target, "decide", {
        requestId: event.target.dataset.deny,
        decision: "deny",
      }, () => say("Denied. They were told, without a reason.", "ok", "policy-msg"), "policy-msg");
    });
  }

  table("invites", ["state", "label", "expires", ""], state.invites || [], (record) =>
    `<tr><td>${escape(record.state)}</td><td>${escape(record.label)}</td>`
    + `<td>${time(record.expiresAt)}</td><td>${record.state === "pending"
      ? `<button data-revoke="${escape(record.inviteId)}">revoke</button>` : ""}</td></tr>`);

  for (const button of document.querySelectorAll("[data-revoke]")) {
    button.addEventListener("click", (event) => {
      void run(event.target, "revokeInvite", { inviteId: event.target.dataset.revoke }, () =>
        say("Invite revoked.", "ok"));
    });
  }

  table("inbox", ["from", "state", "received", "deadline"], state.inbox || [], (record) =>
    `<tr><td>${escape(record.from)}</td><td>${escape(record.state)}</td>`
    + `<td>${time(record.receivedAt)}</td><td>${time(record.deadline)}</td></tr>`);

  table("activity", ["time", "direction", "kind", "state"], (state.activity || []).slice().reverse(), (record) =>
    `<tr><td>${time(record.ts)}</td><td>${escape(record.kind)}</td>`
    + `<td>${escape(record.messageKind)}</td><td>${escape(record.state)}</td></tr>`);
}

function say(text, kind = "", target = "room-msg") {
  const node = document.getElementById(target);
  node.className = `msg ${kind}`;
  node.textContent = text;
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
  void run(event.target, "createRoom", { name }, (result) => {
    const who = result.agents.map((a) => `${a.agentId} (${a.role})`).join(", ");
    // Agents pick the new room up from their own config within half a second;
    // nothing has to be restarted.
    say(`Room "${result.roomName}" created. Switched: ${who}.`, "ok");
  });
});

document.getElementById("join-room").addEventListener("click", (event) => {
  const invite = document.getElementById("invite-input").value.trim();
  if (!invite) return say("Paste an invite code first.", "bad");
  void run(event.target, "joinRoom", { invite }, (result) => {
    document.getElementById("invite-input").value = "";
    const who = result.agents.map((a) => `${a.agentId} (${a.role})`).join(", ");
    say(`Joined "${result.roomName || "room"}". Switched: ${who}.`, "ok");
  });
});

document.getElementById("send-question").addEventListener("click", (event) => {
  const field = document.getElementById("question");
  const question = field.value.trim();
  if (!question) return say("Type a question first.", "bad", "ask-msg");
  void run(event.target, "ask", { question }, () => {
    field.value = "";
    say("Sent. The answer shows up here when their agent replies.", "ok", "ask-msg");
  }, "ask-msg");
});

document.getElementById("toggle-policy").addEventListener("click", (event) => {
  const next = event.target.dataset.next === "manual" ? "manual" : "auto";
  void run(event.target, "setPolicy", { approvals: next }, (result) => {
    say(next === "manual"
      ? "Every incoming request now waits for you."
      : "Requests go straight to your agent."
        + (result.released ? ` Released ${result.released} that were waiting.` : ""),
      "ok", "policy-msg");
  }, "policy-msg");
});

document.getElementById("create-invite").addEventListener("click", (event) => {
  void run(event.target, "createInvite", {}, (result) => {
    const node = document.getElementById("invite-code");
    node.hidden = false;
    node.textContent = result.code;
    const brief = document.getElementById("invite-brief");
    brief.hidden = false;
    brief.textContent = result.instructions || "";
    document.getElementById("brief-actions").hidden = !result.instructions;
    say(`Invite valid until ${new Date(result.expiresAt).toLocaleTimeString()}. Single use.`, "ok");
  });
});

document.getElementById("copy-brief").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.getElementById("invite-brief").textContent);
  say("Briefing copied. Paste it to the other owner's agent.", "ok");
});

document.getElementById("verify-peer").addEventListener("click", (event) => {
  void run(event.target, "verifyPeer", {}, () => say("Peer fingerprint confirmed.", "ok"));
});

void refresh();
setInterval(() => void refresh(), 2000);
