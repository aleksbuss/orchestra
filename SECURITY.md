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

## Internal Hardening Notes

For maintainers and contributors working on the codebase:

- Architectural security rules (path-traversal guard, SSRF guard, secrets hygiene, auth boundaries) live in [`CLAUDE.md`](./CLAUDE.md) → § "🛡 Security Patterns". Apply those patterns when adding any route under `src/app/api/`.
- Known-but-not-yet-fixed security gaps are tracked openly in [`POST_MORTEMS.md`](./POST_MORTEMS.md) with `Status: OPEN`. Coordinate with maintainers before publishing details of OPEN entries.
- Run `npm run scrub:secrets` before sharing the tree externally (issue attachments, repomix bundles, screenshots).
- `.env` and `.env.local` MUST be gitignored; verify before any commit.
