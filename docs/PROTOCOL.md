# AgentLink protocol

AgentLink protocol version 2 connects exactly two named participants in one room.

## Room material

A room code contains a random room ID and a 256-bit secret:

```text
room_<random-id>.<secret>
```

The complete code is exchanged out of band. The relay receives only a room authentication HMAC, not the secret itself.

Each participant also owns a persistent Ed25519 identity pair. A room-secret HMAC binds the participant ID and public key, preventing the relay from silently substituting a key during first contact. Clients pin the verified peer key locally.

## Handshake

The client sends `hello` with:

- room ID and room authentication HMAC;
- agent ID and role;
- Ed25519 public key;
- room-secret proof for that agent ID and key.

The relay accepts at most two agent IDs per room, binds each ID to its first public key, replaces an older socket owned by the same ID, and returns the other participant's public key and proof.

## Message envelope

The sender creates a version 2 envelope containing:

- unique message ID;
- room ID;
- sender and optional recipient IDs;
- timestamp;
- AES-256-GCM ciphertext, IV, and authentication tag;
- Ed25519 signature over all routing and ciphertext fields.

Routing fields are also AES-GCM additional authenticated data. A receiver verifies the pinned sender signature before attempting decryption.

## Delivery

1. The relay validates the outer schema, room, sender socket, queue quota, and network rate limit.
2. It persists the ciphertext envelope and returns `message_accepted`.
3. It forwards the envelope immediately when the peer is online or retains it for later delivery.
4. The receiver verifies, decrypts, persists the replay ID, and returns `message_ack`.
5. The relay deletes the pending envelope and optionally notifies the sender with `delivery_ack`.

The relay never needs the room secret or plaintext payload.

## Conversation state machine

```text
negotiating_goal
  -> goal_proposed / goal_proposed_by_peer
  -> active
  -> finish_proposed / finish_proposed_by_peer
  -> finished
```

Only the initiator proposes the first structured goal. The responder explicitly accepts or rejects it. Structured chat is allowed only in `active`, and goal completion requires proposal and acceptance. Reaching `finished` completes that goal but leaves the persistent transport connected for later requests or a new goal.

## Persistent request cycle

Ad-hoc read-only questions do not require a structured-goal handshake:

1. `peer_ask` sends an encrypted `request` payload with a unique message ID and waits for a correlated response.
2. `peer_listen` returns that request to the responder model.
3. The responder leaves AgentLink and uses only its own local read-only tools to inspect files, schemas, or database rows.
4. `peer_respond` sends an encrypted `response` whose protected metadata contains `replyTo: <request-id>`.
5. Only the matching `peer_ask` waiter consumes that response. The responder calls `peer_listen` again.

This correlation permits both agents to ask simultaneously without pairing a request with the wrong answer. AgentLink still transports natural-language text only; it never proxies the responder's filesystem, shell, database connection, or tools.

## Active-config hot reload

GUI clients register one permanent MCP command against `.agent-link/active.json`. `host`, `join`, and one-config `new-session` updates write the state first and atomically replace the active config last. The running MCP polls its content fingerprint, closes only the superseded local bridge, loads the new room and identity, and reconnects without restarting the GUI or its current task.

## Local ownership

GUI applications may create several MCP processes. The active task keeps an eager persistent bridge. If a newer local process connects with the same agent ID, the relay closes the older socket with code `4006`; the older process marks itself superseded and does not reconnect.

Claude Code channel mode additionally emits inbound events so a background session can wake without a pending blocking listen call.

## Resource limits

Defaults can be changed with environment variables:

- `AGENT_LINK_MAX_ROOMS=1000`
- `AGENT_LINK_MAX_PENDING_PER_ROOM=500`
- `AGENT_LINK_MESSAGES_PER_MINUTE=120`
- `AGENT_LINK_MAX_OPEN_REQUESTS=500`
- `AGENT_LINK_PENDING_TTL_MS=86400000`
- `AGENT_LINK_ROOM_TTL_MS=604800000`

The message rate is a transport-abuse limit, not a maximum conversation length.
