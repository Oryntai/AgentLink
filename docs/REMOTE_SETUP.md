# Remote setup

This guide connects two owners on different machines without a coordinator agent, model API, VPN, port forwarding, or permanent deployment.

## Recommended: temporary ngrok tunnel

Both owners clone the repository and install its packages:

```powershell
git clone https://github.com/Oryntai/AgentLink.git
cd AgentLink
npm ci
```

Only the initiator needs a free ngrok account. Copy the authtoken from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken), keep it out of files and shell history where possible, and set it in the current PowerShell terminal:

```powershell
$env:NGROK_AUTHTOKEN = "your-token"
npm run host -- --agent alice-codex --name "Alice Codex" --client codex
```

The command starts the relay on localhost, opens the ngrok tunnel, creates the local initiator config, installs MCP, and prints a complete `npm run join` command. Send that command privately to the second owner. The host terminal must stay open.

The second owner runs the printed command and selects their actual client:

```powershell
npm run join -- --url "wss://temporary.ngrok.app/ws" --code "ROOM_CODE" --agent bob-claude --name "Bob Claude" --client claude-desktop
```

Valid client values are `codex`, `claude-desktop`, and `claude`. Fully quit and restart both GUI applications after installation. Start the responder task first, then the initiator task. `Ctrl+C` on the host closes both the tunnel and local relay.

For a new task, rerun `host` and use the newly printed `join` command. The room secret and protocol state rotate while the local identity key is preserved.

## Permanent public relay

Use the included Render Blueprint or Dockerfile when the relay must remain available after the initiator closes a terminal.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FOryntai%2FAgentLink)

Convert the resulting HTTPS service address to `wss://host/ws`, then use the advanced commands:

```powershell
npm run create-room -- --agent alice-codex --name "Alice Codex" --relay wss://host/ws
npm run join-room -- --code "ROOM_CODE" --agent bob-claude --name "Bob Claude" --relay wss://host/ws
```

Persist `/app/data` when offline delivery must survive relay restarts.

## Optional private relay

Tailscale is not required. If both owners already use it, one owner can run:

```powershell
$env:AGENT_LINK_HOST = "0.0.0.0"
./scripts/start-relay.ps1
```

Both configs then use `ws://100.x.y.z:8787/ws`. Do not expose plain `ws://` directly to the public internet.

## Verification

On each machine:

```powershell
npm run doctor
```

After mutual `peer_complete`, both agent connections close. The host process and ngrok tunnel remain available until the owner presses `Ctrl+C`.

## Troubleshooting

- Missing `NGROK_AUTHTOKEN`: create a free ngrok account and set the token in the host terminal.
- `Port 8787 is already in use`: stop the old relay or add `--port 8788` to `npm run host`.
- `ECONNREFUSED`: the host terminal is closed or the tunnel is still starting.
- HTTP `301` during WebSocket connection: use the exact printed `wss://.../ws` URL.
- `unauthorized`: the room code differs between participants.
- `agent identity key mismatch`: an agent ID was reused after its local identity was deleted; use a new ID or verify the peer out of band before removing the old trust file.
- Expired session: run `host` and `join` again.
