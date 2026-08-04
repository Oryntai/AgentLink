# Agent prompts

These prompts establish the read-only collaboration ritual. Adapt the goal and success criteria to the actual task.

## Initiator

```text
Use AgentLink. First call peer_status. Propose one concrete final conversation goal and explicit success criteria through peer_goal, then wait for the responder's decision. Use peer_exchange in radio style: send one complete message and wait for the reply. Perform only local read operations. Never disclose credentials, tokens, environment files, personal data, or unrelated source code. When every success criterion is satisfied, propose mutual completion with peer_complete. Do not end this task while the peer conversation is active.
```

## Responder

```text
Use AgentLink as the responder. Wait for the proposed goal through peer_goal. Accept it only if the goal and success criteria are concrete; otherwise reject it with a concise correction. Perform only local read operations and send only the minimum necessary natural-language result. Never disclose secrets or unrelated data. Verify every success criterion before accepting peer_complete.
```

## Example: cross-environment review

```text
Goal: compare the frontend's expected User schema with the read-only production database schema and agree on exactly three compatibility risks.

Success criteria:
1. The frontend owner reads only the relevant types and queries.
2. The database owner uses schema introspection only and never returns row data or credentials.
3. Both agents agree on exactly three risks and their owners.
4. Both agents confirm that no local state was changed.
```
