# Security Policy

## Supported Versions

Security updates are provided on a best-effort basis for the latest state of the `main` branch.

## Reporting a Vulnerability

Please do not report security issues in public GitHub issues.

Contact the maintainer directly via email or use GitHub private vulnerability reporting if available.

Include:

- affected component and version/commit
- clear reproduction steps or proof of concept
- impact assessment
- suggested mitigation (if known)

## Response Process

- initial acknowledgment target: within 72 hours
- status updates: as investigation progresses
- fix and disclosure timing: depends on severity and exploitability

## Deployment Security & Threat Model

Orchestra is a **single-trusted-operator, local-first** application. Read this before exposing it beyond `localhost`.

- **It runs arbitrary code by design.** The `code_execution` and `process` tools execute Python / Node / shell commands via `child_process` with the operator's privileges (passwordless `sudo` inside the official Docker image). Treat a running Orchestra instance as equivalent to a shell on the host. **Do not expose it to untrusted networks or untrusted users.**
- **Bring Your Own Key (BYOK).** Provider API keys live in `data/settings/` (gitignored, never committed) and `.env.local`. They are never logged or sent anywhere except the configured provider. `data/` is the database — back it up; there is no remote sync.
- **Set `ORCHESTRA_AUTH_SECRET` in production.** With `NODE_ENV=production`, Orchestra **refuses to start** on a known-insecure/default session secret (`src/lib/auth/session.ts`). Generate one: `openssl rand -base64 48`. Never enable `ORCHESTRA_DISABLE_AUTH=true` on a reachable deployment.
- **Single-process invariant.** Storage uses an in-process file lock (`withFileLock`); do NOT run in cluster mode (PM2 `instances > 1`, multi-worker containers sharing `data/`) without first migrating to a cross-process lock — concurrent writers will corrupt JSON. The boot guard (`ORCHESTRA_MULTI_PROCESS_OK`) is opt-out only.
- **Untrusted content** (web pages, MCP tool output, uploaded files) is wrapped in `<UNTRUSTED_*>` markers and outbound URLs pass an SSRF guard — but prompt injection is an inherent LLM-agent risk. Keep the operator in the loop for consequential actions.

## Internal Hardening Notes

For maintainers and contributors working on the codebase:

- Architectural security rules (path-traversal guard, SSRF guard, secrets hygiene, auth boundaries) live in [`CLAUDE.md`](./CLAUDE.md) → § "🛡 Security Patterns". Apply those patterns when adding any route under `src/app/api/`.
- Known-but-not-yet-fixed security gaps are tracked openly in [`POST_MORTEMS.md`](./POST_MORTEMS.md) with `Status: OPEN`. Coordinate with maintainers before publishing details of OPEN entries.
- Run `npm run scrub:secrets` before sharing the tree externally (issue attachments, repomix bundles, screenshots).
- `.env` and `.env.local` MUST be gitignored; verify before any commit.
