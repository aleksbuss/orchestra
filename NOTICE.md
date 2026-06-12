# NOTICE

This file documents the licensing of components in this repository that are
**not** covered by the top-level [`LICENSE`](./LICENSE) (MIT). Orchestra ships
with a bundled-skills collection in [`bundled-skills/`](./bundled-skills/) for
out-of-the-box experience; some of those skills retain their original
licensing and are redistributed here under their own terms.

## Origin — upstream attribution (Eggent)

Orchestra is a **hard fork of [Eggent](https://github.com/eggent-ai/eggent)**
(© 2026 Eggent contributors), used here under its MIT License. The original
Eggent codebase was imported as the starting point: Orchestra inherits Eggent's
**workspace scaffold** — the JSON-on-disk storage model, the projects / memory /
knowledge / MCP / cron / Telegram subsystems, the Next.js application shell, and
the base single-agent loop.

Built on top of that scaffold, and **original to Orchestra (not present in
Eggent)**, is the **Mixture-of-Agents (MoA) ensemble** — parallel proposers,
a code-guaranteed Skeptic, tournament aggregation, reflection/disagreement
detection, and trace-memory — which is Orchestra's defining capability, plus a
data-isolation layer, soft-delete + index-integrity recovery, observability /
post-mortem tooling, an expanded test suite, a bilingual RU/EN surface, and
numerous security and reliability fixes.

In accordance with the MIT License, Eggent's copyright notice is retained in
[`LICENSE`](./LICENSE). This attribution is provided in good faith and with
gratitude to the Eggent authors. Orchestra is an independent fork and is not
endorsed by or affiliated with the Eggent project.

## Top-level license

The Orchestra source code (everything outside the exceptions listed below) is
released under the MIT License — see [`LICENSE`](./LICENSE). Code inherited from
Eggent remains under Eggent's MIT grant (see "Origin" above); the two MIT grants
are compatible and both copyright lines are preserved in `LICENSE`.

## Bundled-skills licensing

The `bundled-skills/` directory contains independent "Agent Skills" — small,
self-contained capability modules. Each subdirectory is governed by the
license declared inside it (a `LICENSE` / `LICENSE.txt` file, or a `license:`
field in its `SKILL.md` frontmatter), NOT by the top-level MIT license of
Orchestra.

The MIT grant of Orchestra does **not** extend to these bundled skills.
Operators redistributing or modifying Orchestra together with `bundled-skills/`
must comply with each skill's individual terms.

### Skills with their own LICENSE file

| Skill | License | Source |
| --- | --- | --- |
| [`bundled-skills/autoresearch/`](./bundled-skills/autoresearch/) | MIT (© 2026 Andrej Karpathy) | See [`autoresearch/LICENSE`](./bundled-skills/autoresearch/LICENSE) |
| [`bundled-skills/docx/`](./bundled-skills/docx/) | **Proprietary** (© 2025 Anthropic, PBC. All rights reserved.) | See [`docx/LICENSE.txt`](./bundled-skills/docx/LICENSE.txt) |
| [`bundled-skills/xlsx/`](./bundled-skills/xlsx/) | **Proprietary** (© 2025 Anthropic, PBC. All rights reserved.) | See [`xlsx/LICENSE.txt`](./bundled-skills/xlsx/LICENSE.txt) |

### Skills declaring "Proprietary" in their SKILL.md frontmatter

| Skill | Note |
| --- | --- |
| [`bundled-skills/coding-agent/`](./bundled-skills/coding-agent/) | `license: Proprietary` declared in `SKILL.md` frontmatter; no separate LICENSE file is bundled. The original terms apply. |

### Skills without explicit license declaration

The remaining skills under `bundled-skills/` do not currently carry an
explicit license file. They are bundled here in good faith from public Agent
Skill catalogues (e.g., the Anthropic Skills repository and community
contributions). If you are the author of one of these skills and would like
either (a) clearer attribution or (b) removal from this distribution, please
open an issue. Until each skill's origin is independently verified, treat
them as "license unknown — use at your own risk and do not redistribute as
MIT."

The following skills fall into this category:

```
agent-browser, architect-agent, bear-notes, discord, excalidraw, frontend-expert,
gemini, gh-issues, github, healthcheck, last30days, nano-pdf, notion, obsidian,
openai-image-gen, openai-whisper, openai-whisper-api, playwright-cli, remotion,
session-logs, skill-creator, slack, things-mac, tmux, trello, video-frames,
visual-verifier, voice-call, weather
```

If you intend to redistribute Orchestra commercially or under a stricter
license-audit regime, the safest path is to remove `bundled-skills/` entirely
and let operators install skills from their original sources at runtime.

## Embedded XML schemas

[`bundled-skills/xlsx/scripts/office/schemas/`](./bundled-skills/xlsx/scripts/office/schemas/)
contains Office Open XML (OOXML) schema files from ISO/IEC 29500-4:2016 and
Microsoft. These schemas are redistributed under their own licensing terms,
not under MIT. See [Microsoft Open Specifications](https://docs.microsoft.com/en-us/openspecs/)
for the canonical licensing reference.

## Vendored dependencies

[`src/lib/vendor/pdf-parse/`](./src/lib/vendor/pdf-parse/) contains a vendored
copy of the [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) npm package,
originally MIT-licensed (© Modesty Zhang). The vendored copy was modified for
Next.js compatibility (avoiding a startup-time `require('./test/...')` that
would otherwise break the build). The original MIT license applies.

**Security note on the bundled pdf.js build:** `pdf-parse` embeds pdf.js
v1.10.100 (2018). Orchestra uses it exclusively for server-side *text
extraction* in the RAG loaders — no rendering, no embedded-script evaluation —
which does not exercise the known rendering-path CVEs in old pdf.js (e.g.
CVE-2024-4367). Treat ingested PDFs as untrusted input regardless; replacing
the vendored copy with a maintained extraction path is tracked as tech debt.

[`bundled-skills/last30days/scripts/lib/vendor/bird-search/`](./bundled-skills/last30days/scripts/lib/vendor/bird-search/)
vendors its own `node_modules`, including
[`@steipete/sweet-cookie`](https://www.npmjs.com/package/@steipete/sweet-cookie)
(MIT), a browser-cookie reader. **Why a cookie library ships in this repo:**
the `last30days` skill's X/Twitter search authenticates with the *operator's
own* logged-in browser session by reading the operator's local cookies — on
the operator's machine, at the operator's request, as disclosed in the skill's
`SKILL.md`. Nothing is exfiltrated; the dependency is vendored (rather than
npm-installed) so the skill works offline and survives registry churn. If
this trade-off is not acceptable in your environment, delete
`bundled-skills/last30days/` — nothing else depends on it.

## Trademarks

"Orchestra" as used in this README refers to this software project only and
does not imply endorsement by, affiliation with, or sponsorship by Orchestra
Software, Inc., Orchestra Energy, Inc., or any other entity using the same
name. If you intend to publish a fork under a different identity, choose a
distinct name.
