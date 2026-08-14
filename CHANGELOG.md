# Changelog

All notable changes to AgentLink are documented here.

## 0.5.0 - 2026-08-14

- Added a desktop application: an Electron window that reads link status, the peer's identity with its key fingerprint and verification state, pending requests, and the metadata-only activity ring straight from the local broker in the main process. The renderer is sandboxed behind a context bridge whose only capability is asking for a snapshot, so the window never touches the broker socket and shows no message text. `npm run desktop:web` keeps the older headless page for a machine without a display.
- Added broker protocol negotiation: frontends check the running broker's protocol version, its advertised client range, and its method list before using it, so a restarted MCP process can no longer talk to an older broker that lacks its RPCs.
- Added authenticated graceful takeover: an incompatible broker requeues its in-flight leases, refuses new work while draining, and exits so the newer frontend can start a replacement. A handover is not a failed delivery attempt and never consumes the claim-attempt budget.
- Added `npm run stop-broker` for the one legacy transition, which verifies the target over the local endpoint, prints the pid and command line, and requires an explicit confirmation. Automatic replacement uses authenticated takeover only and never signals a pid read from a file.
- Fixed a stuck-request bug: a broker killed mid-processing left entries in `processing` with a dead owner forever. Both in-flight states now return to the queue on load, and the recovered state is persisted.
- Fixed a half-open local link: a frontend that rejected a broker kept reporting itself connected, so the next attempt silently reused the rejected connection.
- Added a bounded, metadata-only activity ring to the encrypted broker store with an explicit version 1 to version 2 migration. Entries carry only timestamps, kinds, request ids, peer aliases, states, and reasons; request text can never enter it, and it is readable through the `activity_tail` broker method.
- Made required broker methods a frontend capability rather than a global list, so a generic MCP session accepts a broker that lacks desktop-only methods while a desktop frontend replaces it.
- Fixed a misdiagnosis introduced with negotiation: an unanswered `hello` was treated as an old broker. Only an explicit rejection from the broker means that now; silence is retried and then reported as a transport failure.
- Hardened invite codes: every invite now carries an identifier and a required validity window capped at 24 hours, defaults to 15 minutes, and is refused once expired, tampered with, or issued by an unsupported version.
- Added a local invite registry with single-use redemption bound to the first identity that redeems an invite, revocation while pending, and an honest error when revoking an invite that was already used. The registry stores no room code, no room secret, and no invite code.
- Added first-peer binding: a room binds to the first peer identity and public key that prove membership, so a leaked room code cannot admit a different peer even if the relay loses its own membership state. Rotating the room is the documented way to admit someone else.
- Added issuer-side invite redemption during the peer handshake: the joining side presents its invite id with a room-secret proof over the invite, its agent id and its public key, and the issuing side verifies that proof, checks the invite against its own registry, and consumes it against the peer public key before pinning anything. A replayed invite from a different key is refused, and a retry from the same key is idempotent. The relay only forwards the id and the proof; it can compute neither.
- Added an optional `requireInvite` room policy that refuses any peer arriving without an invite.
- Added a peer fingerprint and verification state to bridge status so an owner can confirm out of band who answered; a short-lived invite is consent to connect, not proof of identity.
- Fixed local state writes clobbering each other when two processes share one config: every state file now writes through one atomic helper with unique temporary names and a retry for the transient replace failures Windows raises under concurrent renames.
- Made invite redemption durable before admission: the issuing side records the redemption and only then pins the peer, rolling the consumption back and refusing the connection if the record cannot be written, so a crash can never leave an invite that was consumed only in memory.
- Serialized inbound relay frames so a peer is always pinned before anything it sent is processed, and removed the invite-registry paths that guessed a consumption without an issuer handshake.
- Scoped trust state per room (`<config>.<roomId>.trust.json`), with a one-time import from the older shared file when it describes the same room. Rotating a room now really does admit a different key under the same agent id, and a stale binding can no longer be written back by a process still on the old room.
- Made the cross-process lock refuse to steal a live holder's lock: it records the owner pid and a token, reclaims only when that owner is gone, and releases only a lock it still owns.
- Made concurrent trust-file updates merge instead of overwrite: the read, merge and write now happen under a cross-process lock, pinned keys and bindings never disappear, a completed fingerprint verification wins, and seen message ids are a bounded union. Trust entries are also rebuilt from an allowlist on load.
- Fixed silent message loss on join: the bridge attached its message listener only after its handshake settled, so anything the relay flushed from the offline queue right after the welcome could be dropped. A peer that had never been in the room lost the first message sent to it.
- Fixed the MCP session dying silently when the local broker was momentarily unavailable: the fire-and-forget broker start no longer turns a transient failure into an unhandled rejection, and a broker that exits mid-handshake is simply started again.
- Kept the activity ring off the message hot path: it is marked dirty and flushed with the next real save or by broker maintenance, instead of re-encrypting the whole store on every message.
- Fixed `stop-broker` reporting a stopped broker as still running on Unix: a broker whose parent had not reaped it yet still answers signal 0, so the command now treats a zombie as gone instead of waiting out its timeout.
- Fixed a broker start race: the endpoint accepted clients before the store was loaded and persisted, so an early frontend could reach a broker with no context and observe a store that had not been migrated on disk yet. The address is still claimed first, but connections are served only once initialisation finished.

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
