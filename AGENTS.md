# Instructions for coding agents

## Project purpose

AgentLink connects exactly two local coding-agent sessions through an encrypted relay. It must never invoke a model API or grant one peer direct access to the other peer's machine.

## Development workflow

1. Use Node.js 20 or newer.
2. Install dependencies with `npm ci`.
3. Run `npm run smoke` after every protocol, relay, MCP, crypto, state, or logging change.
4. Run `git diff --check` before committing.

## Non-negotiable invariants

- Keep message contents end-to-end encrypted. The relay must not receive a room secret or plaintext payload.
- Authenticate all envelope routing metadata and verify the sender signature before decryption.
- Preserve the identity-key proof and pinned-peer checks.
- Never write room codes, private keys, auth values, tokens, or plaintext conversation fields to ordinary logs.
- Keep `.agent-link/`, `data/`, `logs/`, and `.env` untracked.
- Do not add a model-provider API dependency. AgentLink is a transport for subscription-backed local clients.
- Do not expose remote filesystem, shell, or database tools through the bridge. Peers exchange natural-language text only.
- Do not impose a conversation message-count limit. Network rate limits may protect the relay from abuse.
- Ad-hoc read-only requests use correlated request IDs and require an explicit local responder loop.
- Structured planning conversations must begin with an explicit goal handshake and end with mutual goal completion.
- Completing one goal must not close the persistent peer transport; only owner shutdown or config hot reload closes it.
- Exactly one authenticated local broker per participant config owns the remote WebSocket; GUI MCP processes are replaceable local frontends.
- An unarmed GUI task must never be treated as available. Generic MCP wakeup is limited to resolving an already pending call.
- Agent-facing instructions must check inbox and outbound status at task start, after substantial work units, before final output, and after owner notification without tight polling.

## Code map

- `src/mcp-server.js`: MCP tools, goal/completion state machine, and Claude channel notifications.
- `src/broker-server.js` and `src/broker-client.js`: singleton owner broker, encrypted durable inbox, authenticated local IPC, claims, receipts, and frontend routing.
- `src/notifier.js` and `scripts/watch.js`: local owner notifications, count-only optional phone webhooks, and the experimental metadata-only Claude watcher.
- `src/bridge-client.js`: WebSocket lifecycle, encrypted delivery, signatures, replay protection, and peer pinning.
- `src/relay-server.js`: ciphertext routing, offline queue, quotas, TTLs, and persistence.
- `src/crypto.js`: room codes, encryption, identity proofs, and envelope signatures.
- `src/logger.js` and `src/log-crypto.js`: redaction, local field encryption, and rotation.
- `scripts/`: setup, client installation, health checks, session rotation, and reports.
- `test/`: direct bridge and MCP integration coverage.

## Compatibility

Protocol changes must either remain compatible with the current envelope version or deliberately increment the version and update both bridge and relay tests. Keep the owner broker connected while an active config exists, hot-reload config changes without restarting the GUI, and enable automatic channel delivery only when `AGENT_LINK_CHANNEL_MODE=1`.

## Security review checklist

For every change, ask whether a malicious relay, a stale local MCP process, a forged peer identity, replayed ciphertext, unbounded queue, or secret-bearing log entry could break an invariant. Add a regression test when the answer is not obviously no.
