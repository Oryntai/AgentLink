import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const main = await readFile(path.join(rootDir, "desktop", "main.js"), "utf8");
const renderer = await readFile(path.join(rootDir, "desktop", "renderer.js"), "utf8");
const html = await readFile(path.join(rootDir, "desktop", "index.html"), "utf8");

assert.match(
  renderer,
  /const active = Boolean\(profile\.claim && profile\.status\?\.connected && !profile\.error\);/,
  "A connected broker must not make an unclaimed Local Duo profile look active.",
);
assert.match(
  renderer,
  /A profile becomes active only after that task claims it\./,
  "The launch guidance must explain the claim step.",
);
assert.match(
  renderer,
  /Step \$\{index \+ 1\} · \$\{escape\(profile\.displayName\)\} task prompt/,
  "Launch prompts must be presented as separate ordered steps.",
);
assert.match(
  renderer,
  /ownerAskLocalDuo/,
  "Local Duo must route the owner composer to the local owner-instruction action.",
);
assert.match(
  html,
  /id="owner-recipient"/,
  "The owner composer must let the owner choose Developer, Reviewer, or both.",
);
assert.match(
  html,
  /id="stop-dialogue"[^>]*>Stop dialogue<\/button><button id="send-question"/,
  "Local Duo must put a stop-dialogue control beside the send button.",
);
assert.match(
  renderer,
  /"stopLocalDuo"/,
  "The stop-dialogue control must call the dedicated Local Duo action.",
);
assert.match(
  renderer,
  /class="copy-message"[\s\S]*data-copy-message=/,
  "Every rendered chat message must expose a compact copy control.",
);
assert.match(
  renderer,
  /navigator\.clipboard\.writeText\(entry\.text\)/,
  "The message copy control must copy exactly the visible message text.",
);
assert.match(
  main,
  /stopLocalDuo: stopLocalDuoDialogue/,
  "The desktop process must route stop-dialogue to both local agents.",
);
assert.match(
  html,
  /\.chat \{[^}]*min-height: 0;[^}]*height: 100vh;[^}]*overflow: hidden;/,
  "The chat column must stay inside the viewport so the composer remains visible.",
);
assert.match(
  html,
  /\.timeline \{[^}]*min-height: 0;[^}]*overflow-y: auto;/,
  "The conversation timeline must own vertical scrolling.",
);
assert.match(
  html,
  /\.recipient-menu \{[^}]*bottom: calc\(100% \+ 8px\);/,
  "The recipient picker must open upward from the owner composer.",
);
assert.match(
  renderer,
  /timeline\.scrollTop = stickToBottom \? timeline\.scrollHeight : previousScrollTop;/,
  "Transcript refreshes must keep manual scroll position and follow new messages at the bottom.",
);
assert.match(
  main,
  /message\.kind === "owner_request" \|\| message\.author === "Owner"[\s\S]*\? "outbound"[\s\S]*: "inbound"/,
  "Only the owner may render as the current user in Local Duo.",
);
assert.match(
  renderer,
  /name: developer\?\.displayName \|\| "Developer",[\s\S]*peer: true,/,
  "Developer must not be labelled as the signed-in owner in Local Duo.",
);
assert.doesNotMatch(
  html,
  /sidebar-bottom|id="link-text"|id="config"/,
  "A duplicate bottom status bar must not cover the chat composer or details panel.",
);

console.log("DESKTOP LOCAL DUO UI PASS: profiles, launch prompts, and owner composer are wired");
