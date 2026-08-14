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

The relay accepts at most two agent IDs per room, binds each ID to its first public key, and returns the other participant's public key and proof. One remote socket is normally created from each owner's singleton broker. During upgrades, multiple sockets with the same authenticated agent ID may coexist so older GUI tasks cannot evict the broker.

A client also binds the room locally to the first peer identity and public key that prove membership, and refuses a different one afterwards. That binding does not depend on the relay remembering its own membership state. Inbound relay frames are serialized so the peer is pinned before anything it sent is processed.

## Invites

An invite code is `al1.<base64url-payload>.<checksum>`. The payload is version 2 and carries an invite ID, the relay URL, the room code, the issue and expiry timestamps, and an optional label. It expires after 15 minutes by default and 24 hours at most; a code that is expired, tampered with, or of an unsupported version is refused at parse time.

Redemption happens between the two clients, not at the relay:

1. The joining side presents its invite ID with a room-secret proof over the invite ID, its agent ID, and its public key.
2. The issuing side verifies that proof, checks the ID against its own registry, and consumes it against the presented public key.
3. The consumption is recorded durably before the peer is pinned. If the record cannot be written, the consumption is rolled back and the peer is refused.

A replay from a different key is refused; a retry from the same key is idempotent. The relay forwards only the ID and the proof and can compute neither. The registry stores no room code, no room secret, and no invite code. A room may set `requireInvite` to refuse any peer arriving without one.

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

### Broker protocol negotiation

Broker protocol version 2 is the minimum. A frontend opens with `hello` and compares the broker's protocol version, its advertised client range, and its method list against what that frontend needs before using it. Required methods are a frontend capability, not one global list: a generic MCP session needs the core methods, while a desktop frontend also needs `activity_tail`, `room_create`, `room_join`, `invite_create`, `invite_list`, `invite_revoke`, `peer_verify`, `policy_get`, `policy_set`, `approval_list`, `approval_decide`, and `conversation_list`.

Only an explicit rejection means the broker is too old. Silence is retried and then reported as a transport failure.

An incompatible broker is replaced by authenticated graceful takeover: it requeues its in-flight leases, refuses new work while draining, and exits so the newer frontend can start a replacement. A handover is not a failed delivery attempt and never consumes the claim-attempt budget. Stopping a broker by pid is an operator command (`npm run stop-broker`), never an automatic path.

### Approval policy

Each owner's store carries one policy for requests arriving from the peer:

- `auto`: the request is queued and dispatched to whichever frontend is waiting. This is the default and how every version before this one behaved.
- `manual`: the request is stored in the `held` state. It is not dispatched, not returned by `inbox_list`, not claimable through `inbox_claim`, and its text is not broadcast to frontends. The owner sees it through the desktop-only `approval_list` and resolves it with `approval_decide`.

Approving moves the request to `queued` and dispatches it normally. Denying removes it and sends a `declined` receipt whose reason is generated locally, so nothing the owner types travels to the peer. A held request still expires on its own deadline. Switching the policy back to `auto` releases every held request, because leaving them gated by a policy that no longer exists would strand them.

The asking side learns about the gate: it receives a `held` receipt and reports that state until the request is approved, denied, or expires.

### Store and activity ring

The encrypted broker store migrates explicitly from version 1 to version 2, which adds a bounded activity ring, and from version 2 to version 3, which adds the approval policy. The policy is rebuilt from a known list on load, so an unrecognised value falls back to the default instead of disabling the gate. Ring entries carry timestamps, kinds, request IDs, peer aliases, states, and reasons only; request text can never enter it. It is read through `activity_tail` and flushed with the next real save or by broker maintenance rather than on the message hot path.

Both in-flight states return to the queue when the store loads, so a broker killed mid-processing cannot strand a request under a dead owner. Trust state is scoped per room in `<config>.<roomId>.trust.json`, imported once from the older shared file when it describes the same room, and merged monotonically under a cross-process lock that reclaims only a dead owner's lock.

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
