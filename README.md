# AgentLink

[![CI](https://github.com/Oryntai/AgentLink/actions/workflows/ci.yml/badge.svg)](https://github.com/Oryntai/AgentLink/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

AgentLink is an encrypted persistent bridge between two local coding agents. It lets Codex and Claude sessions owned by different people request read-only findings from each other's local environments while each owner keeps control of their own machine.

AgentLink does **not** call a model API. Each agent continues to run through its owner's existing Codex or Claude subscription and local GUI/CLI client.

> Status: experimental v0.3. Use it for trusted peer collaboration and review the security notes before exposing a relay outside a private network.

## Why AgentLink

Two developers often have access to different repositories, databases, or environments. Instead of copying context manually, each local agent can inspect only the resources available on its owner's machine and send the minimum necessary natural-language result to the peer.

- No coordinator agent and no shared machine.
- Messages look like normal user messages to both agents.
- A blocking request suspends the asking tool call without generating model tokens.
- The responder leaves `peer_listen`, performs local read-only work, replies, and listens again.
- A permanent MCP installation hot-reloads `.agent-link/active.json`; new rooms do not require a GUI restart.
- Completing one structured goal leaves the encrypted transport connected for later questions.
- The remote peer never receives direct access to local files, terminals, databases, or tools.

## Architecture

```text
Codex / Claude A                                       Codex / Claude B
       |                                                       |
       | stdio MCP                                      stdio MCP |
       v                                                       v
 local AgentLink bridge <--- encrypted WebSocket relay ---> local AgentLink bridge
       |                                                       |
       v                                                       v
 local read-only tools                                  local read-only tools
```

The relay stores ciphertext and delivery metadata. Message contents are encrypted end to end with AES-256-GCM and signed with per-agent Ed25519 identities.

The wire format and state machine are documented in [Protocol](docs/PROTOCOL.md).

## Client behavior

| Client | Waiting model |
| --- | --- |
| Codex Desktop | `peer_ask` remains pending while the responder handles the request; `peer_listen` wakes on an inbound request. |
| Claude Desktop | Uses the same request/listen cycle. A new idle GUI chat cannot currently be awakened by standard MCP. |
| Claude Code | Experimental channel mode can deliver an inbound event to a background session. |

For GUI-to-GUI use, start one task in each application once. Keep the responder task inside `peer_listen`; it returns to the model only when work arrives.

## Requirements

- Node.js 20 or newer
- Git
- Codex Desktop, Claude Desktop, or Claude Code
- One free ngrok account and authtoken for the temporary relay owner

## Quick start: two machines, temporary link

No deployment, domain, port forwarding, VPN, or separate ngrok installation is required. The ngrok SDK is installed by `npm ci` and the public endpoint exists only while the host command is running.

### 1. Clone on both machines

```powershell
git clone https://github.com/Oryntai/AgentLink.git
cd AgentLink
npm ci
```

### 2. The initiator hosts

Get a free token from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken), set it only in the current terminal, and start AgentLink:

```powershell
$env:NGROK_AUTHTOKEN = "your-token"
npm run host -- --agent alice-codex --name "Alice Codex" --client codex
```

In Windows Command Prompt use `set "NGROK_AUTHTOKEN=your-token"`; on macOS or Linux use `export NGROK_AUTHTOKEN="your-token"`. AgentLink starts the local relay, opens the encrypted WebSocket tunnel, activates `.agent-link/active.json`, installs the permanent MCP, and prints one join command.

Keep this terminal open and send the printed command privately to the peer owner. It contains the room secret.

### 3. The peer joins

Run the printed command from the cloned repository. For example:

```powershell
npm run join -- --url "wss://temporary.ngrok.app/ws" --code "ROOM_CODE" --agent bob-claude --name "Bob Claude" --client claude-desktop
```

Valid clients are `codex`, `claude-desktop`, and `claude` for Claude Code. The join command activates the responder config and installs MCP automatically.

### 4. One final restart, then hot reload

After the first AgentLink v0.3 installation, fully quit and restart each GUI once so it discovers the permanent MCP. Future `host`, `join`, and `new-session` commands update `active.json` and switch the already running MCP in place. Press `Ctrl+C` in the host terminal when the persistent link is no longer needed.

## Optional relay modes

For an always-on public relay, deploy the included `render.yaml` or Dockerfile. For a private relay, use Tailscale. For a one-machine test, run:

```powershell
./scripts/start-relay.ps1
```

Then use the advanced `create-room` and `join-room` commands with `ws://127.0.0.1:8787/ws`. See [Remote setup](docs/REMOTE_SETUP.md) for permanent and private alternatives.

For Claude Code's experimental background channel, add `--channel` to `host` or `join`, then launch:

```powershell
claude --dangerously-load-development-channels server:agent-link
```

## Persistent questions during normal work

Start one responder task and keep it alive with this instruction:

```text
Use AgentLink as a persistent responder. Keep peer_listen pending. For every request, inspect only the necessary local files or database data with read-only tools, call peer_respond with the supplied request ID, then immediately call peer_listen again. Never disclose credentials or unrelated data. Do not end this task until your owner tells you to stop.
```

An agent doing ordinary feature work can ask the peer at any point:

```text
Use peer_ask to ask the AgentLink peer which requirements apply to this feature. Wait for its read-only finding, then continue the implementation.
```

The asking MCP call stays pending without model generation. The responder's `peer_listen` returns the question, the responder performs local reads outside AgentLink, and `peer_respond` completes the original call. Request IDs prevent simultaneous questions from consuming the wrong answer.

## Structured planning sessions

`peer_goal`, `peer_exchange`, and `peer_complete` remain available when both agents need an explicit goal and success criteria. Completing that goal returns the link to an idle persistent state instead of closing its WebSocket.

For the next temporary conversation, stop the old host with `Ctrl+C`, run `npm run host` again, and have the peer run the newly printed `npm run join` command.

When using an always-on relay, rotate the room without replacing the local identity. The initiator generates the code:

```powershell
npm run new-session -- .agent-link\alice-codex.json
```

The responder privately receives that code and installs it into the existing local config:

```powershell
npm run new-session -- --code "ROOM_CODE" .agent-link\bob-claude.json
```

The permanent MCP hot-reloads the rotated session. No GUI or task restart is required.

Prompt the initiator:

```text
Use AgentLink. Check peer_status, propose one concrete final conversation goal through peer_goal, and wait for acceptance. Discuss the task through peer_exchange in radio style. Use local read-only operations only and disclose no secrets. Once every success criterion is satisfied, propose mutual completion through peer_complete. Do not end this task while the peer conversation is active.
```

Prompt the responder:

```text
Use AgentLink as the responder. Wait for the proposed goal through peer_goal, accept or reject it explicitly, and use only local read-only operations. Reply with the minimum necessary result and never disclose credentials or unrelated data. Verify all success criteria before accepting peer_complete.
```

## Security model

- AES-256-GCM encrypts message contents and authenticates envelope metadata.
- Ed25519 signs every envelope.
- An HMAC proof binds each public identity key to the room secret.
- Replay IDs survive local MCP process restarts.
- Relay rooms, pending messages, and logs have quotas, TTLs, and rotation.
- Sensitive local JSONL fields are encrypted with a key derived from the local identity key.
- `ROOM_CODE`, `active.json`, identity keys, state, trust files, logs, and reports live under `.agent-link/`, which is ignored by Git.

AgentLink transports text; it cannot technically force a local agent to use read-only tools. Enforce read-only behavior with the prompt, client approvals, sandbox configuration, and least-privilege database credentials.

The relay can observe connection metadata and message sizes. AgentLink does not currently provide forward secrecy. Read [SECURITY.md](SECURITY.md) before production use.

## Operations

```powershell
npm run doctor
npm run report:all
npm run smoke
./scripts/stop-relay.ps1
```

Readable reports are generated only on explicit request under `.agent-link/reports/`. The source JSONL logs keep sensitive message fields encrypted.

## Development

```powershell
npm ci
npm run smoke
```

Coding-agent instructions are in [AGENTS.md](AGENTS.md). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

Release history is recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
