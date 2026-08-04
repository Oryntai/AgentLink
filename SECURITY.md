# Security policy

## Supported versions

AgentLink is currently experimental. Security fixes are applied to the latest commit on `main`; there is no long-term support policy yet.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or a private security advisory for `Oryntai/AgentLink`. Do not publish room codes, identity keys, decrypted logs, proof-of-concept secrets, or other users' data in an issue.

Include the affected commit, attack prerequisites, expected impact, and a minimal reproduction when possible.

## Threat model

AgentLink is designed to protect message contents from an honest-but-curious or compromised relay. It authenticates message envelopes and peer identity keys with secrets exchanged out of band.

AgentLink does not protect against:

- a compromised endpoint or stolen local identity/config files;
- an authorized peer intentionally disclosing received information;
- a local agent ignoring the requested read-only policy;
- traffic analysis based on timing, connection metadata, or ciphertext size;
- historical decryption after endpoint key compromise, because forward secrecy is not yet implemented;
- insecure public deployment of an unencrypted `ws://` relay.

Use Tailscale or `wss://`, rotate the room before each conversation, keep database credentials read-only and least-privileged, and review generated reports before sharing them.
