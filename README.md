# AgentLink

[![CI](https://github.com/Oryntai/AgentLink/actions/workflows/ci.yml/badge.svg)](https://github.com/Oryntai/AgentLink/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

AgentLink is an encrypted conversation bridge between two local coding agents. It lets Codex and Claude sessions owned by different people negotiate a goal, exchange read-only findings, and mutually finish a planning or review session.

AgentLink does **not** call a model API. Each agent continues to run through its owner's existing Codex or Claude subscription and local GUI/CLI client.

> Status: experimental v0.2. Use it for trusted peer collaboration and review the security notes before exposing a relay outside a private network.

## Why AgentLink

Two developers often have access to different repositories, databases, or environments. Instead of copying context manually, each local agent can inspect only the resources available on its owner's machine and send the minimum necessary natural-language result to the peer.

- No coordinator agent and no shared machine.
- Messages look like normal user messages to both agents.
- A blocking exchange suspends the current tool call without generating model tokens.
- A required goal handshake prevents open-ended conversations.
- Mutual completion closes both peer connections automatically.
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
| Codex Desktop | `peer_exchange` remains pending until the peer replies. |
| Claude Desktop | Uses the same blocking exchange. A new idle GUI chat cannot currently be awakened by standard MCP. |
| Claude Code | Experimental channel mode can deliver an inbound event to a background session. |

For GUI-to-GUI use, start one task in each application once. After that, the agents can complete the whole conversation themselves.

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

On macOS or Linux, use `export NGROK_AUTHTOKEN="your-token"` instead. AgentLink starts the local relay, opens the encrypted WebSocket tunnel, creates the initiator config, installs MCP, and prints one join command.

Keep this terminal open and send the printed command privately to the peer owner. It contains the room secret.

### 3. The peer joins

Run the printed command from the cloned repository. For example:

```powershell
npm run join -- --url "wss://temporary.ngrok.app/ws" --code "ROOM_CODE" --agent bob-claude --name "Bob Claude" --client claude-desktop
```

Valid clients are `codex`, `claude-desktop`, and `claude` for Claude Code. The join command creates the responder config and installs MCP automatically.

### 4. Restart and talk

Fully quit and restart both GUI applications. Start the responder task first, then the initiator task. Press `Ctrl+C` in the host terminal when the collaboration is done; the public endpoint immediately stops forwarding.

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

## Start a conversation

The `host` and `join` commands create a fresh room and reset the goal state. Keep the host terminal open, start the responder task, and then start the initiator task.

For the next temporary conversation, stop the old host with `Ctrl+C`, run `npm run host` again, and have the peer run the newly printed `npm run join` command.

When using an always-on relay, rotate the room without replacing the local identity. The initiator generates the code:

```powershell
npm run new-session -- .agent-link\alice-codex.json
```

The responder privately receives that code and installs it into the existing local config:

```powershell
npm run new-session -- --code "ROOM_CODE" .agent-link\bob-claude.json
```

Restart both client tasks after rotating a session.

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
- `ROOM_CODE`, identity keys, state, trust files, logs, and reports live under `.agent-link/`, which is ignored by Git.

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
