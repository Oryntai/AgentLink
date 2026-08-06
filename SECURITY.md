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
- traffic analysis by the relay or tunnel provider based on timing, connection metadata, or ciphertext size;
- historical decryption after endpoint key compromise, because forward secrecy is not yet implemented;
- insecure public deployment of an unencrypted `ws://` relay.

Persistent mode is an availability mechanism, not standing permission to disclose local data. Every responder request must still be handled by the local agent under its owner's read-only prompt, sandbox, approval policy, and least-privilege credentials. `peer_respond` accepts only requests claimed by that authenticated local broker frontend, and correlated responses prevent one simultaneous requester from consuming another request's answer.

The owner broker stores its inbox and response cache as encrypted local files. Its named-pipe or Unix-socket protocol requires an HMAC proof derived from the room secret. This protects against unrelated local users that cannot read the participant config; it does not protect a compromised process running as the owner or any process that can already read `.agent-link/active.json`.

Local desktop notifications may reveal the configured peer alias on the OS lock screen, depending on operating-system settings. Optional phone webhooks receive only notification timing and a pending count, but that metadata can still reveal activity patterns. The webhook URL is a secret and must use HTTPS.

The temporary ngrok mode terminates public TLS at ngrok and forwards to the relay on localhost. Ngrok can observe transport metadata and encrypted AgentLink frames, but message text remains protected by AgentLink's end-to-end encryption. Treat `NGROK_AUTHTOKEN`, `ROOM_CODE`, and `.agent-link/active.json` as secrets, never commit them, and send the printed join command only through a private authenticated channel.

Use temporary ngrok, Tailscale, or another trusted `wss://` endpoint; rotate the room before each collaboration link or when access should be revoked; keep database credentials read-only and least-privileged; and review generated reports before sharing them.
