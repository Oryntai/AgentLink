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

  table("inbox", ["from", "state", "received", "deadline"], state.inbox || [], (record) =>
    `<tr><td>${escape(record.from)}</td><td>${escape(record.state)}</td>`
    + `<td>${time(record.receivedAt)}</td><td>${time(record.deadline)}</td></tr>`);

  table("activity", ["time", "direction", "kind", "state"], (state.activity || []).slice().reverse(), (record) =>
    `<tr><td>${time(record.ts)}</td><td>${escape(record.kind)}</td>`
    + `<td>${escape(record.messageKind)}</td><td>${escape(record.state)}</td></tr>`);
}

void refresh();
setInterval(() => void refresh(), 2000);
