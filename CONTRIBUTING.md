# Contributing to Orchestra

Thanks for helping improve Orchestra.

## Ways to Contribute

- Report bugs
- Propose features
- Improve documentation
- Submit code changes

## Before Opening an Issue

- Search existing issues to avoid duplicates.
- Use the provided issue forms so maintainers get enough context.
- Keep reports focused on one problem/request per issue.

## Report a Bug

Use the `Bug report` template and include:

- what happened
- what you expected
- exact steps to reproduce
- environment details (OS, browser, Docker/local)
- relevant logs or screenshots

If a bug is hard to reproduce, add a minimal reproducible example.

## Request a Feature

Use the `Feature request` template and include:

- problem statement
- proposed solution
- alternatives considered
- expected user impact

## Architecture & Internal Documents

Before opening a non-trivial PR, read:

- [`CLAUDE.md`](./CLAUDE.md) — architectural rules, contracts, and folder map. Treated as doc-as-code: any change that renames or refactors a file referenced there must update the matching section in the same commit.
- [`POST_MORTEMS.md`](./POST_MORTEMS.md) — registry of historical bugs and the rules they encode. Read every entry whose subsystem you are about to touch.
- [`docs/request-flow.md`](./docs/request-flow.md) — end-to-end lifecycle of a user message; the most useful single document for understanding how the codebase fits together.

If your change reveals a new architectural failure mode, add a `POST_MORTEMS.md` entry following the template at the top of that file.

## Development Setup

Node version: see [`.nvmrc`](./.nvmrc) (currently `20`). Run `nvm use` before `npm install` to avoid native-module mismatch.

```bash
npm install
npm run dev
```

Production check:

```bash
npm run lint
npm run build
npm test
```

Before sharing the tree externally (issue attachments, demos, screenshots of editor panes), run:

```bash
npm run scrub:secrets
```

## Pull Request Guidelines

- Create a branch from `main`.
- Keep PRs small and focused.
- Explain the problem and solution clearly.
- Link related issues (for example: `Closes #123`).
- Include screenshots/GIFs for UI changes.
- Update docs when behavior changes.

## Commit Guidance

Conventional commits are recommended but not required.

Examples:

- `fix(chat): handle empty tool output`
- `feat(mcp): add server timeout setting`
- `docs: clarify Docker setup`

## Review and Triage

- Maintainers triage new issues and PRs on a best-effort basis.
- You may be asked for more context or a smaller repro.
- Inactive issues/PRs may be closed after follow-up attempts.
