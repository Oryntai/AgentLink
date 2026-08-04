# Changelog

All notable changes to AgentLink are documented here.

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
