import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyRoom } from "../src/agent-configs.js";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { createRoomCode } from "../src/crypto.js";
import { parseInviteCode } from "../src/invite-code.js";
import { loadLocalDuo, saveLocalDuo } from "../src/local-duo.js";
import { DESKTOP_BROKER_METHODS } from "../src/protocol-version.js";
import { writeParticipantConfig } from "../scripts/setup-lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");
const configPath = path.resolve(
  process.env.AGENT_LINK_CONFIG || path.join(rootDir, ".agent-link/active.json"),
);

let broker = null;
let brokerError = null;
let window = null;
const localDuoClients = new Map();

async function ensureBroker() {
  if (broker) return broker;
  const config = await loadBridgeConfig(configPath);
  broker = new BrokerClient(config, {
    requiredMethods: DESKTOP_BROKER_METHODS,
    clientType: "desktop",
  });
  await broker.connect();
  return broker;
}

function installCodexMcp(config, { bootstrap = false } = {}) {
  const args = [
    path.join(rootDir, "scripts", "install-mcp.js"),
    "--config", config,
    "--client", "codex",
  ];
  if (bootstrap) args.push("--bootstrap");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: rootDir, windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not install the Codex connection (exit ${code})`));
    });
  });
}

async function joinFromDesktop({ invite: inviteCode, displayName }) {
  const invite = parseInviteCode(inviteCode);
  const configDir = path.dirname(configPath);
  let isNewCodexConnection = false;
  try {
    await loadBridgeConfig(configPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (path.basename(configPath).toLowerCase() !== "active.json") {
      throw new Error("Desktop quick join needs the default .agent-link/active.json path");
    }
    const agentId = `desktop-${invite.inviteId.replace(/-/g, "").slice(0, 12)}`;
    const created = await writeParticipantConfig({
      configDir,
      relayUrl: invite.relayUrl,
      roomCode: invite.roomCode,
      agentId,
      displayName: String(displayName || "").trim().slice(0, 64) || agentId,
      role: "responder",
    });
    await installCodexMcp(created.activeConfigPath);
    isNewCodexConnection = true;
  }
  const agents = await applyRoom(configDir, {
    roomCode: invite.roomCode,
    roomName: invite.label,
    relayUrl: invite.relayUrl,
    inviteId: invite.inviteId,
  });
  await broker?.close().catch(() => {});
  broker = null;
  return {
    roomName: invite.label,
    expiresAt: invite.expiresAt,
    agents,
    isNewCodexConnection,
  };
}

async function availablePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function localRelayHealthUrl(relayUrl) {
  const url = new URL(relayUrl);
  url.protocol = "http:";
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url;
}

async function localRelayReady(relayUrl) {
  try {
    const response = await fetch(localRelayHealthUrl(relayUrl), {
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureLocalDuoRelay(relayUrl, configDir) {
  if (await localRelayReady(relayUrl)) return;
  const relay = new URL(relayUrl);
  if (relay.hostname !== "127.0.0.1" || relay.protocol !== "ws:") {
    throw new Error("Local Duo can start only its own ws://127.0.0.1 relay");
  }
  const child = spawn(process.execPath, [path.join(rootDir, "src", "relay-server.js")], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_LINK_HOST: "127.0.0.1",
      AGENT_LINK_PORT: relay.port,
      AGENT_LINK_DATA_FILE: path.join(configDir, "local-duo-relay.json"),
    },
  });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await localRelayReady(relayUrl)) return;
  }
  throw new Error("The Local Duo relay did not start");
}

async function workspacePath(value) {
  const candidate = path.resolve(value || rootDir);
  const result = await stat(candidate).then((entry) => entry.isDirectory()).catch(() => false);
  if (!result) throw new Error(`Workspace folder does not exist: ${candidate}`);
  return candidate;
}

async function createLocalDuo(payload) {
  const configDir = path.dirname(configPath);
  if (await loadLocalDuo(configDir)) {
    throw new Error("A Local Duo already exists. Its two profiles are ready to claim.");
  }
  const developerWorkspace = await workspacePath(payload.developerWorkspace);
  const reviewerWorkspace = await workspacePath(payload.reviewerWorkspace || payload.developerWorkspace);
  const roomName = String(payload.roomName || "Local Duo").trim().slice(0, 64) || "Local Duo";
  const port = await availablePort();
  const relayUrl = `ws://127.0.0.1:${port}/ws`;
  await ensureLocalDuoRelay(relayUrl, configDir);
  const roomCode = createRoomCode();
  const developer = await writeParticipantConfig({
    configDir,
    relayUrl,
    roomCode,
    agentId: "local-developer",
    displayName: String(payload.developerName || "Developer").trim().slice(0, 64) || "Developer",
    role: "initiator",
    activate: false,
  });
  const reviewer = await writeParticipantConfig({
    configDir,
    relayUrl,
    roomCode,
    agentId: "local-reviewer",
    displayName: String(payload.reviewerName || "Reviewer").trim().slice(0, 64) || "Reviewer",
    role: "responder",
    activate: false,
  });
  const duo = await saveLocalDuo(configDir, {
    version: 1,
    roomName,
    relayUrl,
    createdAt: new Date().toISOString(),
    profiles: [
      {
        id: "developer",
        agentId: developer.config.agentId,
        displayName: developer.config.displayName,
        role: developer.config.role,
        workspace: developerWorkspace,
        configPath: developer.configPath,
        claim: null,
      },
      {
        id: "reviewer",
        agentId: reviewer.config.agentId,
        displayName: reviewer.config.displayName,
        role: reviewer.config.role,
        workspace: reviewerWorkspace,
        configPath: reviewer.configPath,
        claim: null,
      },
    ],
  });
  await installCodexMcp(configPath, { bootstrap: true });
  return duo;
}

async function sendOwnerInstructionToLocalDuo({ question, recipient }) {
  const text = String(question || "").trim();
  if (!text) throw new Error("Write a message for the agents first");
  const requested = recipient || "both";
  if (!["developer", "reviewer", "both"].includes(requested)) {
    throw new Error("Choose Developer, Reviewer, or both agents");
  }
  const configDir = path.dirname(configPath);
  const duo = await loadLocalDuo(configDir);
  if (!duo) throw new Error("Create Local Duo before messaging local agents");
  const profiles = duo.profiles.filter((profile) => requested === "both" || profile.id === requested);
  const deliveries = await Promise.all(profiles.map(async (profile) => {
    const config = await loadBridgeConfig(profile.configPath);
    let client = localDuoClients.get(profile.id);
    if (!client || client.config.configPath !== config.configPath || client.config.roomCode !== config.roomCode) {
      await client?.close().catch(() => {});
      client = new BrokerClient(config, {
        requiredMethods: DESKTOP_BROKER_METHODS,
        clientType: "desktop",
      });
      localDuoClients.set(profile.id, client);
    }
    await client.connect();
    const sent = await client.ownerRequestSend(text);
    return { profileId: profile.id, displayName: profile.displayName, ...sent };
  }));
  return { deliveries };
}

async function stopLocalDuoDialogue() {
  return sendOwnerInstructionToLocalDuo({
    recipient: "both",
    question: "Priority instruction from the owner: stop the current agent-to-agent dialogue immediately. Do not send any more messages to the peer about the current topic. Reply briefly to the owner that the dialogue has stopped, then remain online and wait for a new owner instruction.",
  });
}

async function readLocalDuoState() {
  const configDir = path.dirname(configPath);
  const duo = await loadLocalDuo(configDir);
  if (!duo) return null;
  await ensureLocalDuoRelay(duo.relayUrl, configDir);
  const profiles = await Promise.all(duo.profiles.map(async (profile) => {
    try {
      const config = await loadBridgeConfig(profile.configPath);
      let client = localDuoClients.get(profile.id);
      if (!client || client.config.configPath !== config.configPath || client.config.roomCode !== config.roomCode) {
        await client?.close().catch(() => {});
        client = new BrokerClient(config, {
          requiredMethods: DESKTOP_BROKER_METHODS,
          clientType: "desktop",
        });
        localDuoClients.set(profile.id, client);
      }
      await client.connect();
      const [status, transcript] = await Promise.all([
        client.remoteStatus(),
        client.listTranscript({ limit: 100 }),
      ]);
      return {
        ...profile,
        claim: processIsAlive(profile.claim?.pid) ? profile.claim : null,
        status,
        transcript: transcript.messages || [],
        error: null,
      };
    } catch (error) {
      return {
        ...profile,
        claim: processIsAlive(profile.claim?.pid) ? profile.claim : null,
        status: null,
        transcript: [],
        error: error.message,
      };
    }
  }));
  const messages = new Map();
  for (const profile of profiles) {
    for (const message of profile.transcript) {
      const key = message.kind === "request" && message.requestId
        ? `request:${message.requestId}`
        : message.messageId || message.id;
      const current = messages.get(key);
      if (!current || (message.direction === "outbound" && current.direction !== "outbound")) {
        messages.set(key, message);
      }
    }
  }
  return {
    ...duo,
    profiles: profiles.map(({ transcript, ...profile }) => profile),
    messages: [...messages.values()].map((message) => ({
      ...message,
      // Direction is from the human viewer's perspective in Local Duo. The
      // two agents are both chat participants, never the signed-in owner.
      direction: message.kind === "owner_request" || message.author === "Owner"
        ? "outbound"
        : "inbound",
    })),
  };
}

// The renderer never touches the broker socket: it asks for a snapshot and gets
// back only what the window is allowed to show.
async function readState() {
  try {
    const localDuo = await readLocalDuoState();
    if (localDuo) {
      return { ok: true, mode: "local_duo", configPath, localDuo };
    }
  } catch (error) {
    return { ok: false, configPath, error: `Local Duo: ${error.message}` };
  }
  try {
    const client = await ensureBroker();
    const [status, activity, inbox, invites, policy, waiting, transcript] = await Promise.all([
      client.remoteStatus(),
      client.activityTail(60),
      client.listInbox(),
      client.listInvites().then((result) => result.invites).catch(() => []),
      client.getPolicy(),
      client.listApprovals().then((result) => result.waiting),
      client.listTranscript({ limit: 100 }),
    ]);
    brokerError = null;
    return {
      ok: true,
      configPath,
      status,
      activity: activity.activity || [],
      invites,
      policy,
      // The transcript is encrypted in the local broker store and exposed only
      // through this owner-controlled window. The activity ring below remains
      // metadata-only.
      waiting,
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
    // A broker that went away must not wedge the window; the next poll retries.
    brokerError = error.message;
    broker = null;
    return { ok: false, configPath, error: brokerError };
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b1020",
    title: "AgentLink Messenger",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.setMenuBarVisibility(false);
  void window.loadFile(path.join(here, "index.html"));
  // Nothing in this window should ever navigate anywhere.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    window = null;
  });
}

ipcMain.handle("agentlink:state", () => readState());
ipcMain.handle("agentlink:transcript", async (event, options = {}) => {
  try {
    return { ok: true, result: await (await ensureBroker()).listTranscript(options) };
  } catch (error) {
    broker = null;
    return { ok: false, error: error.message };
  }
});

// Actions the window is allowed to take. Each one returns a plain result or a
// plain error string; the renderer never sees a broker object.
const actions = {
  createLocalDuo,
  ownerAskLocalDuo: sendOwnerInstructionToLocalDuo,
  stopLocalDuo: stopLocalDuoDialogue,
  createRoom: async (payload) => (await ensureBroker()).createRoom(payload.name),
  joinRoom: (payload) => joinFromDesktop(payload),
  createInvite: async (payload) => (await ensureBroker()).createInvite({ label: payload.label }),
  revokeInvite: async (payload) => (await ensureBroker()).revokeInvite(payload.inviteId),
  verifyPeer: async (payload) => (await ensureBroker()).verifyPeer(payload.fingerprint),
  ask: async (payload) => (await ensureBroker()).requestSend(payload.question, { retainQuestion: true }),
  decide: async (payload) => (await ensureBroker()).decideApproval(payload.requestId, payload.decision),
  setPolicy: async (payload) => (await ensureBroker()).setPolicy(payload.approvals),
};

ipcMain.handle("agentlink:action", async (event, name, payload = {}) => {
  const action = actions[name];
  if (!action) return { ok: false, error: `Unknown action: ${name}` };
  try {
    return { ok: true, result: await action(payload) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", () => {
  void broker?.close().catch(() => {});
  for (const client of localDuoClients.values()) void client.close().catch(() => {});
});

// Not top-level await: with an ESM entry point Electron waits for this module
// to finish evaluating before it becomes ready, so awaiting readiness here
// would deadlock and no window would ever appear.
app.whenReady().then(createWindow);
