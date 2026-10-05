# NOTICE

This file documents the licensing of components in this repository that are
**not** covered by the top-level [`LICENSE`](./LICENSE) (MIT). Orchestra ships
with a bundled-skills collection in [`bundled-skills/`](./bundled-skills/) for
out-of-the-box experience; most of those skills are third-party works that
keep their upstream licenses and are redistributed here under those terms.

## Origin — upstream attribution (Eggent)

Orchestra is a **hard fork of [Eggent](https://github.com/eggent-ai/eggent)**
(© 2026 Eggent contributors), used here under its MIT License. An early version
of the Eggent codebase was imported as the starting point (upstream has since
changed substantially and Orchestra does not track it, so everything in this
section describes that early snapshot, not Eggent as it is today): Orchestra
inherits Eggent's **workspace scaffold** — the JSON-on-disk storage model, the
projects / memory / knowledge / MCP / cron / Telegram subsystems, the Next.js
application shell, and the base single-agent loop.

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

## Adapted third-party material

- **Aggregator prompt.** [`src/lib/agent/moa-prompts.ts`](./src/lib/agent/moa-prompts.ts)
  adapts the synthesis prompt from Together AI's
  [`togethercomputer/MoA`](https://github.com/togethercomputer/MoA) reference
  implementation (`prompts.py`), which is licensed under the
  [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). The prompt
  was modified for Orchestra; the changes are listed in the comment at the top
  of that file. No endorsement by Together AI is implied.

## Bundled-skills licensing

The `bundled-skills/` directory contains "Agent Skills" — small, self-contained
capability modules. Almost all of them are **third-party works that keep the
license of the project they were copied from**; the MIT license of Orchestra does
**not** extend to them. The notices those licenses require are reproduced in
[`bundled-skills/THIRD-PARTY-LICENSES.md`](./bundled-skills/THIRD-PARTY-LICENSES.md),
which travels with the directory (including inside the Docker image).

Sources were established in an October 2026 audit by comparing each `SKILL.md`
line by line with the upstream file as it stood around the copy date
(February–May 2026). A skill is attributed to an upstream only when the two
match — typically 90–100 % of lines; the OpenClaw set matches that project's
2026-02-27 state exactly.

| Upstream | License | Skills |
| --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | MIT, © 2025 Peter Steinberger | 21 skills — `bear-notes`, `discord`, `gemini`, `gh-issues`, `github`, `healthcheck`, `nano-pdf`, `notion`, `obsidian`, `openai-image-gen`, `openai-whisper`, `openai-whisper-api`, `session-logs`, `skill-creator`, `slack`, `things-mac`, `tmux`, `trello`, `video-frames`, `voice-call`, `weather` |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT, © 2025 Addy Osmani | 24 engineering-workflow skills (`api-and-interface-design` … `using-agent-skills`) |
| [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | MIT, © 2026 Matt Van Horn | `last30days` |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Apache-2.0, © 2025 Vercel Inc. | `agent-browser` |
| [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) | Apache-2.0, © Microsoft Corporation | `playwright-cli` |

Skills not covered by that table:

| Skill | Status |
| --- | --- |
| `autoresearch` | Instructions that drive Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch); none of its code is included, and neither `SKILL.md` nor `setup-macos.sh` matches a file of that project or of its MLX port (about 6 % shared lines). The directory carries a `LICENSE` naming Karpathy (MIT); note that the upstream repository itself publishes no license file. |
| `graphify` | Written for Orchestra (added to this repository on 2026-08-15) — MIT, Orchestra contributors. |
| `architect-agent`, `visual-verifier`, `frontend-expert` | Present since Orchestra's first commit. Path-based history lookups found no commit touching them in Eggent or OpenClaw, two of them carry the `orchestra` metadata key (so they were written after the rename), and no public copy was found. Treated as original to Orchestra (MIT). If you recognise one as your work, please open an issue. |
| `excalidraw` | Added to Eggent on 2026-02-25 ("new skills", ilya-bov) and inherited with the Eggent snapshot. Its own upstream could not be identified (compared with ten public Excalidraw skills; none matched). Covered by Eggent's MIT (© 2026 Eggent contributors) to the extent Eggent's contributors wrote it. |

If you are the author of a skill listed here and want the attribution corrected
or the skill removed, please open an issue. If you intend to redistribute
Orchestra commercially or under a stricter license-audit regime, the safest path
is still to delete `bundled-skills/` and let operators install skills from their
original sources at runtime.

## Vendored dependencies

**Removed 2026-08-25 — `src/lib/vendor/pdf-parse/`.** This section used to cover a
vendored copy of [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) (MIT,
© Modesty Zhang), which embedded a pdf.js v1.10.100 build from 2018 — 64,171
lines and 2.1 MB. The note here closed with *"replacing the vendored copy with a
maintained extraction path is tracked as tech debt"*; that replacement had in fact
already shipped. PDF text extraction now runs through `pdfjs-dist`
(`src/lib/memory/loaders/pdf-loader.ts`), and the vendored tree had **zero
importers** — nothing outside it referenced `pdf-parse`, and nothing imported
anything under `lib/vendor` at all. Deleted along with the `node-ensure`
dependency, whose only consumer in the entire tree was a `require` inside that
dead pdf.js bundle. Treat ingested PDFs as untrusted input regardless.

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
