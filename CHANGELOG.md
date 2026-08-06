# Changelog

All notable changes to AgentLink are documented here.

## 0.4.0 - 2026-08-06

- Added one singleton local broker per owner so multiple Codex or Claude tasks no longer replace each other's remote connection.
- Added an identity-authenticated local IPC layer, encrypted durable inbox, claim leases, deadlines, receipts, and sender-scoped request idempotency with cached response replay.
- Added `peer_inbox_list` and `peer_inbox_claim` for requests that arrive while no model task is listening.
- Added nonblocking `peer_request_send` and task-scoped `peer_request_status`, including acknowledged-result retention and recovery after a blocking `peer_ask` timeout.
- Embedded safe-checkpoint inbox/status rules directly in MCP instructions so agents know when to drain work without tight polling.
- Added local desktop notifications and optional count-only HTTPS/ntfy phone notifications without exposing request text or stable request identifiers to the push provider.
- Added an experimental metadata-only `npm run watch` process for Claude Code harnesses that can wake a live task on background-process completion.
- Added deterministic routing across explicit task, workspace, tags, and oldest matching pending claim.
- Kept headless model spawning disabled; AgentLink still uses subscription-backed clients and never invokes a model API.
- Added regression coverage for multi-task claims, inbox draining, deduplication, notification configuration, and broker-backed hot reload.

## 0.3.0 - 2026-08-04

- Added a permanent MCP installation backed by hot-reloaded `.agent-link/active.json`.
- Added correlated `peer_ask`, `peer_listen`, and `peer_respond` tools for ad-hoc read-only work during normal development.
- Kept the encrypted WebSocket connected after completing an individual structured goal.
- Made repeated Codex and Claude Desktop installation idempotent so only the v0.3 upgrade needs one final GUI restart.
- Added regression coverage for local-work response loops, repeated listening, in-process room switching, and permanent MCP installation.

## 0.2.0 - 2026-08-04

- Added `npm run host` to launch the local relay and an ephemeral ngrok tunnel together.
- Added `npm run join` to create the remote participant config and install MCP in one command.
- Made temporary two-machine sessions the default workflow with no deployment, domain, VPN, port forwarding, or separate ngrok binary.
- Preserved participant identity keys across room recreation and reset goal state automatically.
- Added validation and regression tests for tunnel URL conversion and generated configs.

## 0.1.1 - 2026-08-04

- Added one-click public WSS relay deployment through Render.
- Made Tailscale an optional private-network alternative instead of a requirement.
- Added support for hosting platforms that inject the standard `PORT` variable.
- Added a CI Docker build so the public relay image is validated before release.

## 0.1.0 - 2026-08-04

Initial experimental release.

- Encrypted two-agent WebSocket relay with offline delivery.
- MCP tools for status, goal negotiation, radio-style exchange, escalation, and mutual completion.
- Codex and Claude Desktop blocking mode plus experimental Claude Code channel mode.
- AES-256-GCM payload protection, Ed25519 envelope signatures, room-key identity proofs, peer pinning, and replay protection.
- Relay quotas, TTLs, rate protection, persisted queues, and debounced state writes.
- Encrypted sensitive local log fields, rotation, readable reports, and health diagnostics.
- Local and two-machine session rotation.
- Windows helper scripts, Docker relay image, CI, security guidance, and coding-agent instructions.
