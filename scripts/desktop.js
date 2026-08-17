import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { DESKTOP_BROKER_METHODS } from "../src/protocol-version.js";

const configPath = path.resolve(
  process.argv[2] || process.env.AGENT_LINK_CONFIG || ".agent-link/active.json",
);
const host = process.env.AGENT_LINK_DESKTOP_HOST || "127.0.0.1";
const port = Number(process.env.AGENT_LINK_DESKTOP_PORT || 4737);

const config = await loadBridgeConfig(configPath);
const broker = new BrokerClient(config, { requiredMethods: DESKTOP_BROKER_METHODS });

async function readState() {
  try {
    const [status, activity, inbox, transcript] = await Promise.all([
      broker.remoteStatus(),
      broker.activityTail(60),
      broker.listInbox(),
      broker.listTranscript({ limit: 100 }),
    ]);
    return {
      ok: true,
      configPath,
      status,
      activity: activity.activity || [],
      transcript,
      inbox: inbox.map((entry) => ({
        requestId: entry.requestId,
        state: entry.state,
        from: entry.displayName || entry.from,
        receivedAt: entry.receivedAt,
        deadline: entry.deadline,
      })),
    };
  } catch (error) {
    return { ok: false, configPath, error: error.message };
  }
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentLink Desktop</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #ffffff; --ink: #14161a; --muted: #5d6470;
    --line: #e3e6ea; --ok: #157f4a; --warn: #9a6b00; --bad: #a32020; --accent: #2b5cd9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f25; --ink: #eef1f5; --muted: #99a1ad;
      --line: #2b3038; --ok: #4ec98a; --warn: #e0b34d; --bad: #ef7a7a; --accent: #7aa2ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 18px 24px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  .path { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; }
  main { padding: 20px 24px 40px; display: grid; gap: 18px; max-width: 1000px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  section > h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted);
    margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--line); font-weight: 600;
  }
  .rows { padding: 6px 16px 14px; }
  .row { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; }
  .row + .row { border-top: 1px solid var(--line); }
  .k { color: var(--muted); }
  .v { font-family: ui-monospace, monospace; font-size: 13px; text-align: right; word-break: break-all; }
  .pill {
    display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px;
    font-family: system-ui, sans-serif; border: 1px solid currentColor;
  }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .scroll { max-height: 340px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left; color: var(--muted); font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.06em; padding: 8px 16px;
    position: sticky; top: 0; background: var(--panel); border-bottom: 1px solid var(--line);
  }
  td { padding: 7px 16px; border-bottom: 1px solid var(--line); font-family: ui-monospace, monospace; }
  tr:last-child td { border-bottom: 0; }
  .empty { padding: 18px 16px; color: var(--muted); }
  .chat { max-height: 560px; overflow: auto; padding: 14px 16px; background: var(--bg); }
  .bubble { width: fit-content; max-width: min(82%, 720px); margin: 0 0 12px; padding: 10px 12px 8px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
  .bubble.outgoing { margin-left: auto; border-color: var(--ok); }
  .bubble-meta { display: flex; justify-content: space-between; gap: 18px; color: var(--muted); font-size: 11px; }
  .bubble-body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; }
  .receipt { font-size: 11px; color: var(--muted); }
  .outgoing .receipt { text-align: right; color: var(--ok); }
  footer { padding: 0 24px 28px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>AgentLink Desktop</h1>
  <span id="link" class="pill warn">connecting</span>
  <span class="path" id="config"></span>
</header>
<main>
  <section>
    <h2>Link</h2>
    <div class="rows" id="link-rows"></div>
  </section>
  <section>
    <h2>Peer</h2>
    <div class="rows" id="peer-rows"></div>
  </section>
  <section>
    <h2>Agent conversation</h2>
    <div class="chat" id="transcript"></div>
  </section>
  <section>
    <h2>Pending requests</h2>
    <div class="scroll" id="inbox"></div>
  </section>
  <section>
    <h2>Activity (metadata only)</h2>
    <div class="scroll" id="activity"></div>
  </section>
</main>
<footer>Conversation text stays in the encrypted local broker store. This read-only view shows the latest 100 messages.</footer>
<script>
  const rows = (target, pairs) => {
    document.getElementById(target).innerHTML = pairs
      .map(([k, v]) => '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>')
      .join("");
  };
  const esc = (value) => String(value ?? "—").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const time = (value) => (value ? new Date(value).toLocaleTimeString() : "—");
  const outbound = {
    queued_local: "Sending…", relay_acked: "Sent to relay", sent: "Sent to relay",
    delivered: "Delivered", queued: "Delivered · waiting for agent",
    held: "Delivered · waiting for approval", claimed: "Read by their agent",
    processing: "Read · their agent is working", responded: "Read · answered",
    read: "Read by their agent", declined: "Declined", expired: "Expired",
  };
  const inbound = {
    unread: "Not read by your agent", queued: "Waiting for your agent",
    held: "Waiting for your approval", claimed: "Read by your agent",
    processing: "Your agent is working", responded: "Your agent replied",
    read: "Read by your agent", declined: "Declined", expired: "Expired",
  };
  const messageStatus = (m) => {
    const label = (m.direction === "outbound" ? outbound : inbound)[m.state] || m.state || "Recorded";
    return m.reason ? label + " · " + m.reason : label;
  };

  async function refresh() {
    let state;
    try {
      state = await (await fetch("/api/state")).json();
    } catch {
      state = { ok: false, error: "desktop server unreachable" };
    }
    const badge = document.getElementById("link");
    document.getElementById("config").textContent = state.configPath || "";
    if (!state.ok) {
      badge.className = "pill bad";
      badge.textContent = "broker unavailable";
      rows("link-rows", [["error", esc(state.error)]]);
      rows("peer-rows", [["status", "unknown"]]);
      return;
    }
    const s = state.status || {};
    badge.className = "pill " + (s.connected ? "ok" : "bad");
    badge.textContent = s.connected ? "connected" : "offline";
    rows("link-rows", [
      ["relay", s.connected ? "connected" : "disconnected"],
      ["room", esc(s.roomId)],
      ["this agent", esc(s.agentId) + " (" + esc(s.role) + ")"],
      ["frontends", esc(s.frontends)],
      ["queued messages", esc(s.queuedMessages)],
    ]);
    const peer = s.peer;
    rows("peer-rows", peer
      ? [
        ["agent", esc(peer.agentId)],
        ["online", s.peerOnline ? "yes" : "no"],
        ["key fingerprint", esc(peer.fingerprint)],
        ["verification", '<span class="pill ' + (peer.verification === "verified" ? "ok" : "warn") + '">'
          + esc(peer.verification) + "</span>"],
        ["bound at", time(peer.boundAt)],
      ]
      : [["status", "no peer bound to this room yet"]]);

    const transcript = state.transcript?.messages || [];
    document.getElementById("transcript").innerHTML = transcript.length
      ? transcript.map((m) => '<article class="bubble ' + (m.direction === "outbound" ? "outgoing" : "incoming") + '">'
        + '<div class="bubble-meta"><span>' + esc(m.author) + '</span><span>' + esc(m.kind) + ' · ' + time(m.createdAt) + '</span></div>'
        + '<div class="bubble-body">' + esc(m.text) + '</div>'
        + '<div class="receipt">' + (m.direction === "outbound" ? "✓ " : "") + esc(messageStatus(m)) + '</div></article>').join("")
      : '<div class="empty">The agents have not exchanged messages in this room yet.</div>';

    const inbox = state.inbox || [];
    document.getElementById("inbox").innerHTML = inbox.length
      ? '<table><thead><tr><th>from</th><th>state</th><th>received</th><th>deadline</th></tr></thead><tbody>'
        + inbox.map((r) => "<tr><td>" + esc(r.from) + "</td><td>" + esc(r.state) + "</td><td>"
          + time(r.receivedAt) + "</td><td>" + time(r.deadline) + "</td></tr>").join("")
        + "</tbody></table>"
      : '<div class="empty">Nothing waiting.</div>';

    const activity = (state.activity || []).slice().reverse();
    document.getElementById("activity").innerHTML = activity.length
      ? '<table><thead><tr><th>time</th><th>direction</th><th>kind</th><th>state</th></tr></thead><tbody>'
        + activity.map((a) => "<tr><td>" + time(a.ts) + "</td><td>" + esc(a.kind) + "</td><td>"
          + esc(a.messageKind) + "</td><td>" + esc(a.state) + "</td></tr>").join("")
        + "</tbody></table>"
      : '<div class="empty">No activity recorded yet.</div>';
  }

  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;

const server = http.createServer(async (request, response) => {
  if (request.url === "/api/state") {
    const state = await readState();
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(state));
    return;
  }
  if (request.url === "/" || request.url === "/index.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

// A chromeless window with its own taskbar entry, using the browser engine that
// is already installed. This is an application window, not a native app: there
// is no tray, no menu bar, and no packaging.
function findBrowser() {
  const candidates = process.platform === "win32"
    ? [
      path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
      path.join(process.env.ProgramFiles || "", "Microsoft/Edge/Application/msedge.exe"),
      path.join(process.env.ProgramFiles || "", "Google/Chrome/Application/chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
    ]
    : [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/microsoft-edge",
      "/usr/bin/chromium",
    ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

async function openWindow(url) {
  const browser = findBrowser();
  if (!browser) {
    console.log("No Chromium-based browser found; open the address above yourself.");
    return null;
  }
  const profile = await mkdtemp(path.join(os.tmpdir(), "agent-link-desktop-"));
  const child = spawn(browser, [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    "--window-size=980,860",
    "--no-first-run",
    "--no-default-browser-check",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

server.listen(port, host, async () => {
  const url = `http://${host}:${port}`;
  console.log(`AgentLink Desktop listening on ${url}`);
  console.log(`Config: ${configPath}`);
  if (process.env.AGENT_LINK_DESKTOP_NO_WINDOW !== "1") await openWindow(url);
});

async function shutdown() {
  await broker.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
