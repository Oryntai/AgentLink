import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../src/broker-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { DESKTOP_BROKER_METHODS } from "../src/protocol-version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..");
const configPath = path.resolve(
  process.env.AGENT_LINK_CONFIG || path.join(rootDir, ".agent-link/active.json"),
);

let broker = null;
let brokerError = null;
let window = null;

async function ensureBroker() {
  if (broker) return broker;
  const config = await loadBridgeConfig(configPath);
  broker = new BrokerClient(config, { requiredMethods: DESKTOP_BROKER_METHODS });
  await broker.connect();
  return broker;
}

// The renderer never touches the broker socket: it asks for a snapshot and gets
// back only what the window is allowed to show.
async function readState() {
  try {
    const client = await ensureBroker();
    const [status, activity, inbox] = await Promise.all([
      client.remoteStatus(),
      client.activityTail(60),
      client.listInbox(),
    ]);
    brokerError = null;
    return {
      ok: true,
      configPath,
      status,
      activity: activity.activity || [],
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
    width: 980,
    height: 860,
    minWidth: 620,
    minHeight: 520,
    backgroundColor: "#14161a",
    title: "AgentLink",
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

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", () => {
  void broker?.close().catch(() => {});
});

// Not top-level await: with an ESM entry point Electron waits for this module
// to finish evaluating before it becomes ready, so awaiting readiness here
// would deadlock and no window would ever appear.
app.whenReady().then(createWindow);
