const escape = (value) => String(value ?? "—").replace(
  /[<>&]/g,
  (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[character]),
);
const time = (value) => (value ? new Date(value).toLocaleTimeString() : "—");

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

function say(text, kind = "") {
  const node = document.getElementById("room-msg");
  node.className = `msg ${kind}`;
  node.textContent = text;
}

async function run(button, name, payload, onDone) {
  button.disabled = true;
  say("Working…");
  const answer = await window.agentlink.act(name, payload);
  button.disabled = false;
  if (!answer.ok) {
    say(answer.error, "bad");
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

document.getElementById("create-invite").addEventListener("click", (event) => {
  void run(event.target, "createInvite", {}, (result) => {
    const node = document.getElementById("invite-code");
    node.hidden = false;
    node.textContent = result.code;
    say(`Invite valid until ${new Date(result.expiresAt).toLocaleTimeString()}. Single use.`, "ok");
  });
});

document.getElementById("verify-peer").addEventListener("click", (event) => {
  void run(event.target, "verifyPeer", {}, () => say("Peer fingerprint confirmed.", "ok"));
});

void refresh();
setInterval(() => void refresh(), 2000);
