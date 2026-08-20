---
name: graphify
description: Navigate a codebase through a local tree-sitter knowledge graph instead of grepping blindly. Use when asked how a medium-or-large codebase works, where a symbol is defined, what calls what, how two modules connect, or when planning a refactor that spans files. Requires the external `graphify` Python CLI; degrades to grep when it is absent.
---

# Graphify — code navigation by graph, not by grep

Graphify parses a repository into a local knowledge graph and answers structural questions without
reading whole files into context. Code is parsed with tree-sitter — deterministic and offline. (Non-code
documents go through an LLM pass when a provider key is present; inside `code_execution` there is no
key, so what you get is the free AST path.)

**This skill is a wrapper around an external CLI. It is not installed by default.** Everything below
runs through `code_execution`. See [`docs/references/graphify-integration-adr.md`](../../docs/references/graphify-integration-adr.md)
for why this is a skill and not a tool.

## Decision — graphify first, grep second (read this before you touch `find`/`grep`)

You loaded this skill because a codebase question came up. The measured failure mode is loading it and
then grepping anyway. Do not. Make the call explicitly:

| The question is… | Do this |
| --- | --- |
| Where is `X` defined? What calls `X`? (you have the symbol name) | **`graphify explain "X"`** — the cheapest, highest-precision call here. Measured 971 chars vs 1668 for the equivalent grep, and it reports call DIRECTION, which grep cannot. |
| What breaks if I change `X`? | **`graphify affected "X"`** (reverse traversal). |
| How do `A` and `B` connect? | **`graphify path "A" "B"`** — but empty output is NOT proof of no connection (dynamic imports, DI, string-keyed registries). |
| How is this codebase structured? Planning a cross-file refactor? | **`graphify query "<identifiers>" --budget 500`** — see the budget warning below; never call `query` without `--budget`. |
| A literal string/comment/config value; a file whose path you already know; the exact current text of lines you are about to edit; a command's exit code; a field inside a JSON file | `grep` / `read_text_file`. The graph models code STRUCTURE — it does not model runtime values or literal text. Routing these through it returns confident noise. **This is the right call, not a shortcut.** |
| Probe (`graphify --version`) failed, or no index exists and building is not appropriate here | Fall back to `grep`, and say plainly the graph is unavailable. |

⚠️ **`query`'s default budget does not hold.** `--budget N` is documented as "cap output at N tokens (default 2000)". Measured on a 5100-node graph: the cap is applied to the *node* set only, and edge lines ship unmetered — one `query` emitted **29,977 chars (~7,500 tokens), 3.7× the stated default**, byte-identical at `--budget 2000` and `--budget 8000`. Only `--budget 500` truncated correctly. Natural-language questions also seed the traversal from common English words (a question containing "path" seeded the node literally named `path`, exploding it to 257 nodes, 193 of them cut) — **query with identifiers, not prose**.

Earlier revisions of this skill said "if you catch yourself about to grep, issue a `graphify query` instead." That was withdrawn: measured, it was ignored in ~2/3 of runs *because the tasks were literal*, and a directive that is correctly ignored teaches the model to discount every other directive it ships with. Pick by question shape.

## Step 0 — probe before you rely on it

Run this first, every session, before promising the user a graph-based answer:

```bash
graphify --version
```

**Not found → stop using this skill.** Fall back to `grep`/`glob`/reading files, and say plainly that
the graph is unavailable. Do not attempt to install it: it is a Python CLI (`uv tool install graphifyy`
— note the double `y`), installing it is an operator decision, not yours.

## Step 1 — confirm you are pointed at the right repository

`code_execution` already starts you in the active project directory. **Do not `cd` outside it.**
Graphify answers from `./graphify-out/graph.json` relative to the working directory and does **not**
search parent directories — so a stray `cd` means confident, well-structured answers about the wrong
codebase.

If no index exists yet, graphify fails loudly:

```
error: graph file not found: <cwd>/graphify-out/graph.json
```

and exits non-zero. Building one is **two commands**, in this order:

```bash
graphify .                # extract: AST for code, writes graphify-out/graph.json
graphify cluster-only .   # name the communities, write GRAPH_REPORT.md
```

`graphify .` prints the second command for you when it finishes. If building is not appropriate here,
fall back to grep.

## Step 2 — keep the index honest

**If you have edited files since your last graphify call in this session, run `graphify update .` before querying.**
Otherwise the graph describes the code as it was before your edits and will contradict what you just wrote.

Rules:

- Do **not** re-index before every query. `graphify update .` writes into the project and can race with concurrent writes.
- If you are running as one of several parallel proposers, **query only — never re-index.** Concurrent updates tear the index.
- `graphify update .` can fail on syntactically incomplete code you just wrote. A failed update means
  *"no fresh graph"* — it does not mean *"nothing changed"*. Fix the syntax or fall back to reading the file.

## Step 3 — query

**Once the probe passes and an index exists, your first navigation action is a query — not `find`, not
`grep`, not a full file tree.** The observed failure mode is not a bad query, it is no query at all:
across five live runs on a 336-file indexed repository, the agent loaded this skill, ran `graphify
--version`, and then explored with `find`/`grep` anyway in every run but one — including runs where the
user named the skill explicitly. Confirming the index and then grepping spends the setup and throws the
payoff away.

```bash
graphify query "auth"                    # broad: a scoped subgraph around matching nodes
graphify explain "authMiddleware"        # focused: one node and its neighbours
graphify path "ApiClient" "authMiddleware"   # how two things connect
```

**`query` matches identifier tokens, not natural language.** Ask it for symbols, files and names —
not for questions. Measured on a real index: `"auth"` → 8 nodes, `"telegram"` → 35 nodes, but
`"authentication"` → **0 nodes** and `"how does authentication work"` → **0 nodes**. If a query
returns nothing, your first hypothesis is a wrong token, not an absent feature: retry with a shorter
identifier or a name you have seen in the tree.

Prefer `query` and `explain` over dumping files. Use them to *locate* code; read the actual lines only
once you know which ones matter.

Keep output small. If a query returns more than roughly a screenful, narrow it rather than pushing the
whole result into your reasoning — the graph is a map, not the territory.

**Trust markers.** Edges printed `[EXTRACTED]` come from AST parsing — structural fact. Nodes carrying
`verification: "unverified"` came from the LLM document pass and may be hallucinated; graphify flags
them itself. Do not build an argument on an unverified node without reading the source.

## Step 4 — read results with the right epistemics

**An empty `path` result is not proof that two things are unconnected.**

tree-sitter sees static syntax. It does not see dynamic imports, string-keyed registries, dependency
injection, event buses, reflection, generated code, database-level coupling (shared tables, foreign
keys), configuration and environment coupling, cross-process calls, or MCP hops. It also cannot see
whatever the index is stale on or the parser skipped.

An empty result means: **"no static AST edge in this parser's current graph."** Nothing more.

Real example from a live codebase: `graphify path "ApiClient" "authMiddleware"` → *"No path found"*, while
the client sets `headers['X-Telegram-Init-Data']` and the middleware reads that exact header. One string
literal across an HTTP boundary — total coupling, zero static edges.

- An empty `path` should **lower** your confidence, never zero it.
- Never write "X and Y are unconnected" on the strength of a `path` result. Write "no static call path
  found; dynamic wiring not ruled out" — and check the suspected dynamic mechanism directly.
- Use the graph to *generate* hypotheses and to *find* code. Do not use it to *refute* claims.

If you are reviewing or critiquing another agent's claim, this applies with full force: a graph query
is evidence, not a verdict.

## When not to use this skill

- Small projects, or when you already know the file — just read it.
- Anything requiring the literal current text of specific lines you are about to edit. Read the file;
  the graph is derived and may lag.
- Non-code questions. The graph indexes source, not intent.
