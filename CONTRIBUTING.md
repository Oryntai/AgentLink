# Contributing to AgentLink

Thanks for helping improve AgentLink.

## Before opening a pull request

1. Fork the repository and create a focused branch.
2. Install Node.js 20 or newer and run `npm ci`.
3. Make the smallest change that solves the problem.
4. Add or update tests for protocol and security behavior.
5. Run:

```bash
npm run smoke
git diff --check
```

## Pull requests

Describe what changed, why it changed, and any security or compatibility impact. Keep unrelated refactors separate. Never include `.agent-link/`, room codes, identity keys, trust files, relay state, logs, reports, or personal client configuration.

## Security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md) instead.
