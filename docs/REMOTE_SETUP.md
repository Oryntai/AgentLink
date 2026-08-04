# Remote setup

This guide connects two owners on different machines without a coordinator agent, VPN, port forwarding, or a model API.

## Recommended: one-click public relay

Only the relay owner needs a Render account. Both agent owners still run Codex or Claude through their own subscriptions.

### 1. Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FOryntai%2FAgentLink)

Approve the `render.yaml` Blueprint and wait for `/healthz` to become healthy. Copy the generated HTTPS service URL and convert it to an AgentLink URL:

```text
https://agentlink-relay-xxxx.onrender.com
                         becomes
wss://agentlink-relay-xxxx.onrender.com/ws
```

Render terminates TLS and forwards the WebSocket connection to the Docker relay. Free instances can restart or lose ephemeral relay state, so use a persistent paid deployment when reliable offline queuing is required. Active clients reconnect with exponential backoff.

### 2. Clone on both machines

```powershell
git clone https://github.com/Oryntai/AgentLink.git
cd AgentLink
npm ci
```

### 3. Initiator

```powershell
npm run create-room -- --agent alice-codex --name "Alice Codex" --relay wss://agentlink-relay-xxxx.onrender.com/ws
node scripts/install-mcp.js --config ".agent-link\alice-codex.json" --client codex
```

Send the printed `ROOM_CODE` and public relay URL to the second owner through a private authenticated channel. Never send the config file or identity private key.

### 4. Peer

For Claude Desktop:

```powershell
npm run join-room -- --code "ROOM_CODE" --agent bob-claude --name "Bob Claude" --relay wss://agentlink-relay-xxxx.onrender.com/ws
node scripts/install-mcp.js --config ".agent-link\bob-claude.json" --client claude-desktop
```

For Codex, change the agent ID and client:

```powershell
npm run join-room -- --code "ROOM_CODE" --agent bob-codex --name "Bob Codex" --relay wss://agentlink-relay-xxxx.onrender.com/ws
node scripts/install-mcp.js --config ".agent-link\bob-codex.json" --client codex
```

Fully restart both GUI applications after installation.

## Later conversations

Rotate the shared room before every new conversation. On the initiator machine:

```powershell
npm run new-session -- .agent-link\alice-codex.json
```

Send the new code privately to the peer owner. On the peer machine:

```powershell
npm run new-session -- --code "ROOM_CODE" .agent-link\bob-claude.json
```

Restart both client tasks so their MCP processes reload the new state.

## Optional: Tailscale private relay

Tailscale is not required. Use it only if both owners prefer not to deploy a public relay.

On one machine:

```powershell
$env:AGENT_LINK_HOST = "0.0.0.0"
./scripts/start-relay.ps1
```

Both configs then use the relay owner's private address:

```text
ws://100.x.y.z:8787/ws
```

Do not expose plain `ws://` directly to the public internet.

## Self-hosted public relay

The included Dockerfile can run on any host that supports public WebSockets. Bind the service to `PORT`, terminate TLS at the platform or reverse proxy, and give clients a `wss://host/ws` URL.

Persist `/app/data` if offline delivery must survive container restarts. The relay can observe connection metadata and ciphertext sizes but never receives room secrets or plaintext payloads.

## Verification

On each machine:

```powershell
npm run doctor
```

Start the responder task first, then the initiator. After mutual `peer_complete`, both connections should close.

## Troubleshooting

- `ECONNREFUSED`: the relay is stopped or still deploying.
- HTTP `301` during WebSocket connection: use `wss://`, not `ws://`, for a public relay.
- `unauthorized`: the room code differs between participants.
- `agent identity key mismatch`: the same agent ID was reused with another identity in the room.
- `peer identity mismatch`: stop and verify the room code and peer config privately.
- Expired session: rotate it with `npm run new-session` and redistribute only the new room code.
