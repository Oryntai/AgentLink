# Remote setup

This guide connects two owners on different machines without a coordinator agent.

## Recommended network: Tailscale

Install Tailscale on both machines and confirm they can reach each other's Tailscale IP. Run the relay on only one machine.

### Relay owner

```powershell
git clone https://github.com/Oryntai/AgentLink.git
cd AgentLink
npm ci
$env:AGENT_LINK_HOST = "0.0.0.0"
./scripts/start-relay.ps1
```

Allow TCP port `8787` only on the private Tailscale interface when configuring a firewall.

Create the initiator config with the relay owner's Tailscale IP:

```powershell
npm run create-room -- --agent alice-codex --name "Alice Codex" --relay ws://100.x.y.z:8787/ws
```

Send the printed `ROOM_CODE` to the second owner through a private authenticated channel.

### Peer owner

```powershell
git clone https://github.com/Oryntai/AgentLink.git
cd AgentLink
npm ci
npm run join-room -- --code "ROOM_CODE" --agent bob-claude --name "Bob Claude" --relay ws://100.x.y.z:8787/ws --channel
```

Install the generated config into the local client using the commands printed by the setup script, then fully restart that client.

## Later conversations

For every new conversation, rotate the shared room. On the initiator machine:

```powershell
npm run new-session -- .agent-link\alice-codex.json
```

Send the newly printed code privately to the peer owner. On the peer machine:

```powershell
npm run new-session -- --code "ROOM_CODE" .agent-link\bob-claude.json
```

Restart both client tasks so their MCP processes reload the new session state.

## Public hosting

If a private overlay network is unavailable, place the relay behind a reverse proxy with TLS and use `wss://`. Restrict access by IP or an additional network layer where possible. Never expose `ws://` over the public internet.

The relay needs persistent storage for `data/relay-state.json` if offline delivery should survive restarts. Docker deployments should mount `/app/data` and `/app/logs` as writable volumes.

## Verification

On each machine, run:

```powershell
npm run doctor
```

Start the responder task first, then the initiator task. The initiator should call `peer_status`, negotiate the goal, and use `peer_exchange`. After mutual `peer_complete`, both connections should close.

## Troubleshooting

- `ECONNREFUSED`: relay is stopped, bound only to localhost, or blocked by a firewall.
- `unauthorized`: the room code differs between participants.
- `agent identity key mismatch`: an agent ID was reused with another identity in the same room; create a new room or restore the original config.
- `peer identity mismatch`: stop and verify the room code and peer config privately before retrying.
- Expired session: run `npm run new-session` and redistribute the new room code privately.
