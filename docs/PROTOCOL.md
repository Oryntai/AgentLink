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

The relay accepts at most two agent IDs per room, binds each ID to its first public key, and returns the other participant's public key and proof. v0.4 normally creates one remote socket from each owner's singleton broker. During upgrades, multiple sockets with the same authenticated agent ID may coexist so older GUI tasks cannot evict the broker.

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

1. `peer_ask` sends an encrypted `request` payload with a sender-scoped idempotency key, routing key, deadline, and unique envelope ID, then waits for a correlated response.
2. `peer_listen` returns that request to the responder model.
3. The responder leaves AgentLink and uses only its own local read-only tools to inspect files, schemas, or database rows.
4. `peer_respond` sends an encrypted `response` whose protected metadata contains `replyTo: <request-id>`.
5. Only the matching `peer_ask` waiter consumes that response. The responder calls `peer_listen` again.

This correlation permits both agents to ask simultaneously without pairing a request with the wrong answer. Replaying a completed idempotency key returns a cached response; replaying an in-flight key returns its current receipt instead of duplicating work. AgentLink still transports natural-language text only; it never proxies the responder's filesystem, shell, database connection, or tools.

The sender may use blocking `peer_ask` or nonblocking `peer_request_send`. Both create the same durable outbound request object. `peer_request_status(requestId)` exposes its full receipt lifecycle and response body when terminal. Without an ID it returns body-free, unacknowledged summaries scoped to the calling task; cross-task recovery is explicit. Fetching a terminal object acknowledges it without deleting it, and acknowledged results remain directly fetchable during the response-cache grace period.

## Owner broker and inbox

Each owner runs one local broker for a participant config. GUI tasks connect as authenticated local MCP frontends over a named pipe on Windows or Unix socket elsewhere. The broker owns the remote WebSocket, encrypts its durable inbox at rest, and routes a request only to a frontend with a pending claim.

Encrypted request metadata may contain:

- `requestId`: sender-scoped idempotency key;
- `routingKey`: optional explicit task ID, workspace hint, or tags;
- `deadline`: absolute UTC expiry;
- `displayName`: local notification label.

The outbound lifecycle uses `queued_local`, `relay_acked`, `queued`, `claimed`, `processing`, `declined`, `expired`, or `responded`. A relay acceptance only proves the ciphertext reached the relay; an owner receipt proves the peer broker decrypted and persisted it.

Requests move through `queued -> claimed(lease) -> responded`. Frontend disconnect, cancellation, or lease expiry requeues the request. Repeated failed claims move it to a local dead-letter state and emit a declined receipt. An expired deadline emits an expired receipt. Among pending claims, routing specificity wins (`taskId > workspace > tags`), then the oldest waiter.

## Active-config hot reload

GUI clients register one permanent MCP command against `.agent-link/active.json`. `host`, `join`, and one-config `new-session` updates write the state first and atomically replace the active config last. The running MCP polls its content fingerprint, closes only the superseded local bridge, loads the new room and identity, and reconnects without restarting the GUI or its current task.

## Local ownership

GUI applications may create several MCP processes. They register ephemeral frontend/task identities with the single broker instead of opening competing relay sockets. An unarmed task is never treated as available. Standard MCP cannot inject a new model turn into an unarmed GUI; such requests remain in the inbox and notify the owner. Experimental client-specific notification modes are capabilities, not portable wake guarantees.

The optional Claude Code watcher is a local frontend with `wakeMode=background_watcher`. It waits for queue metadata without claiming or printing the request body, exits once, and relies on experimentally observed harness behavior to surface that process completion to the model. The awakened task must still claim the inbox item explicitly. Failure to wake never removes the request from the broker inbox.

## Resource limits

Defaults can be changed with environment variables:

- `AGENT_LINK_MAX_ROOMS=1000`
- `AGENT_LINK_MAX_PENDING_PER_ROOM=500`
- `AGENT_LINK_MESSAGES_PER_MINUTE=120`
- `AGENT_LINK_MAX_OPEN_REQUESTS=500`
- `AGENT_LINK_PENDING_TTL_MS=86400000`
- `AGENT_LINK_ROOM_TTL_MS=604800000`

The message rate is a transport-abuse limit, not a maximum conversation length.
