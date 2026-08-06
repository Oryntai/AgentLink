import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function windowsToast(title, body) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$doc.LoadXml('${xml.replaceAll("'", "''")}')`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentLink').Show($toast)",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    encoded,
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function unixNotification(title, body) {
  const command = process.platform === "darwin" ? "osascript" : "notify-send";
  const args = process.platform === "darwin"
    ? ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]
    : [title, body];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function loadSettings(settingsPath) {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function phoneCountPush(count, settings, event = "agentlink_pending") {
  const url = process.env.AGENT_LINK_PHONE_WEBHOOK_URL || settings.phoneWebhookUrl;
  if (!url) return;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("AGENT_LINK_PHONE_WEBHOOK_URL must use HTTPS");
  const ntfy = settings.phoneProvider === "ntfy";
  const noun = event === "agentlink_uncollected_response" ? "uncollected response" : "pending request";
  await fetch(parsed, {
    method: "POST",
    headers: ntfy
      ? { "content-type": "text/plain; charset=utf-8", title: "AgentLink" }
      : { "content-type": "application/json" },
    body: ntfy
      ? `AgentLink has ${count} ${noun}${count === 1 ? "" : "s"}`
      : JSON.stringify({ event, count }),
    signal: AbortSignal.timeout(5_000),
  });
}

export async function notifyIncomingRequest({ peerAlias, pendingCount, settingsPath }) {
  const settings = settingsPath ? await loadSettings(settingsPath).catch(() => ({})) : {};
  const localEnabled = process.env.AGENT_LINK_NOTIFY === "0" ? false : settings.local !== false;
  if (localEnabled) {
    const body = peerAlias
      ? `Read-only request from ${peerAlias}`
      : "New read-only request";
    if (process.platform === "win32") windowsToast("AgentLink", body);
    else unixNotification("AgentLink", body);
  }
  await phoneCountPush(pendingCount, settings).catch(() => {});
}

export async function notifyUncollectedResponse({ pendingCount, settingsPath }) {
  const settings = settingsPath ? await loadSettings(settingsPath).catch(() => ({})) : {};
  const localEnabled = process.env.AGENT_LINK_NOTIFY === "0" ? false : settings.local !== false;
  if (localEnabled) {
    const body = `${pendingCount} uncollected peer response${pendingCount === 1 ? "" : "s"}`;
    if (process.platform === "win32") windowsToast("AgentLink", body);
    else unixNotification("AgentLink", body);
  }
  await phoneCountPush(pendingCount, settings, "agentlink_uncollected_response").catch(() => {});
}
