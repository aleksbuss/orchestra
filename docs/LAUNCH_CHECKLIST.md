# Launch checklist — Orchestra public release

Sequenced 7-step plan to take Orchestra from local-only to publicly-shared. Total time: **~1.5–2 hours of focused work**. Steps marked 🤖 are already done by AI; steps marked 👤 require you.

> **Why this order?** Screenshots go *before* the GitHub push so the first time anyone visits the repo they see a visual demo, not a placeholder. API key rotation goes *before* the push so any keys ever in cleartext are dead by the time the repo is public.

---

## Pre-flight: state right now 🤖

- ✅ 7 commits, all authored as `Aleksejs Buss <aleksbuss@gmail.com>`
- ✅ `gh` CLI installed and authed as `aleksbuss` (scope `repo`)
- ✅ No `.env*` or `data/` files tracked
- ✅ `npm run build` passes
- ✅ Lint clean (39 pre-existing warnings, 0 errors)
- ✅ 1430+ tests passing (1 PM #20 flake under parallel CPU load — pre-existing)

---

## Step 1 — Set git config locally (one-time, 1 minute) 👤

The repo currently has no `user.name`/`user.email` set in `.git/config`. Existing commits already carry your identity (via `-c` flags), but future commits will fail without this. Run:

```bash
cd /Users/aleksejsbuss/eggent/eggent-main
git config user.name "Aleksejs Buss"
git config user.email "aleksbuss@gmail.com"
```

(Local to the repo only — does NOT change your global git identity.)

---

## Step 2 — Capture screenshots + 1 demo GIF (60–90 minutes) 👤

**The single highest-ROI thing you can do for job-search visibility.** README without visuals reads as "abandoned experiment"; README with a 30-second GIF of MoA in action reads as "shipped product".

### 2.1 Boot the app

```bash
npm run dev
# Wait until "Ready" line appears, then open http://localhost:3000
# Log in with admin/admin → onboarding wizard
```

### 2.2 What to capture (in priority order)

| # | Frame | Why this shot | Filename |
|---|---|---|---|
| 1 | **Demo GIF: MoA Swarm in action.** Open a project chat → toggle Swarm ON in the toolbar → ask a non-trivial question (e.g. *"Review this Python script for security issues: [paste 20-30 lines]"*). Record from the moment you press Enter through the Swarm Activity panel showing Router → 3-5 Proposers → Aggregator rendering live. Stop when the assistant message starts streaming. | Captures the **unique selling point**. No other open-source AI workspace shows multi-agent orchestration as clearly. | `docs/assets/demo-swarm.gif` |
| 2 | **Screenshot: chat panel with completed swarm response.** Same chat, after the response is done, with the Swarm Activity panel still open showing all 5 agent nodes completed. | Static fallback for the GIF (some Markdown readers don't autoplay). | `docs/assets/swarm-completed.png` |
| 3 | **Screenshot: Projects dashboard.** Sidebar visible with 2-3 example projects, main panel showing project details with knowledge files and a few cron jobs. | Shows the product surface beyond just chat. | `docs/assets/projects-dashboard.png` |
| 4 | **Screenshot: Skills installer.** `Settings → Skills` page mid-installation of a skill from GitHub, or showing 5-10 installed skills with their icons. | Shows the extensibility story. | `docs/assets/skills-installer.png` |

### 2.3 Recording tools (macOS)

- **GIF**: [Kap](https://getkap.co/) (free, clean output) or [LICEcap](https://www.cockos.com/licecap/) (smaller files).
  - Target: **30–60 seconds**, **≤8 MB**, **800×500 px or smaller** for GitHub's auto-embed.
  - Settings: 15 FPS is plenty; record at 1× speed (the swarm-DAG animation is the point).
- **PNG**: Cmd+Shift+4 (built-in), or [CleanShot X](https://cleanshot.com/) if you have it.
  - Target: **PNG**, **width 1200–1600 px**, no operating-system chrome (use window-only capture).
  - Crop tightly — no empty desktop edges.

### 2.4 Embed in README

Once files are in `docs/assets/`, replace this block in [`README.md`](../README.md):

```markdown
<!-- TODO: Add a 30-60s screencast or animated GIF showing the MoA-swarm
     visualization here. The Swarm Activity panel running a real query is
     the most distinctive view of the project. Place under docs/assets/. -->

<!-- Screenshots placeholder ... -->

> _Screenshots and demo GIF coming soon — see [issue #1](#)._
```

…with:

```markdown
![Orchestra MoA Swarm in action](docs/assets/demo-swarm.gif)

| Chat with Swarm | Projects dashboard | Skills installer |
|:---:|:---:|:---:|
| ![](docs/assets/swarm-completed.png) | ![](docs/assets/projects-dashboard.png) | ![](docs/assets/skills-installer.png) |
```

Then commit:

```bash
git add docs/assets/ README.md
git commit -m "docs: add demo GIF and screenshots"
```

---

## Step 3 — Rotate every API key that ever lived on disk in cleartext (10 minutes) 👤

`npm run scrub:secrets` moved your keys out of `data/settings/settings.json` into `.env.local` (which is gitignored). But any key that **was ever** in plaintext on your filesystem should be considered exposed — `tar` backups, Time Machine snapshots, accidental screen-share, etc.

Open each provider's console and rotate:

- [ ] **OpenRouter** → https://openrouter.ai/settings/keys → revoke old, create new
- [ ] **OpenAI** → https://platform.openai.com/api-keys → same
- [ ] **Anthropic** → https://console.anthropic.com/settings/keys → same
- [ ] **Google AI** → https://aistudio.google.com/app/apikey → same
- [ ] **Tavily** (if you use it) → https://app.tavily.com/home → same
- [ ] **Telegram bot token** (if applicable) → talk to [@BotFather](https://t.me/BotFather) → `/revoke` and `/newbot` or `/token`

Update `.env.local` with the new keys. Restart `npm run dev` to pick them up.

---

## Step 4 — Verify build still passes locally (2 minutes) 👤

After screenshots + env updates, sanity-check:

```bash
npm run lint    # should exit 0
npm test        # should report 1430+/1441 passing (1 flake is OK)
npm run build   # should produce .next/ without errors
```

If anything is red, fix before pushing public.

---

## Step 5 — Create + push the public GitHub repo (3 minutes) 👤

```bash
cd /Users/aleksejsbuss/eggent/eggent-main

# Verify you're authed as the right account.
gh auth status

# Create the public repo and push main in one shot.
gh repo create orchestra \
  --public \
  --description "Self-hosted AI agent workspace with Mixture-of-Agents orchestration. Local-first, MIT-licensed, ~1400 tests." \
  --homepage "" \
  --source=. \
  --remote=origin \
  --push
```

Expected output:

```
✓ Created repository aleksbuss/orchestra on GitHub
✓ Added remote https://github.com/aleksbuss/orchestra.git
✓ Pushed commits to https://github.com/aleksbuss/orchestra.git
```

Open the URL and visually confirm:

- README renders with badges
- The demo GIF auto-plays
- LICENSE shows MIT
- Code tab shows the tree without secret files

---

## Step 6 — Post-push polish (15 minutes) 👤

### 6.1 Repository settings on GitHub

Visit `https://github.com/aleksbuss/orchestra/settings`:

- [ ] **About panel** (right sidebar of the repo page) — add topics: `ai-agents`, `mixture-of-agents`, `nextjs`, `typescript`, `local-first`, `self-hosted`, `llm`, `claude`, `openai`, `swarm`. These drive GitHub's recommended-repos surface.
- [ ] **Discussions** — enable in Settings → General → Features. The issue templates already link to `/discussions`.
- [ ] **Security advisories** — enable in Settings → Security → Code security and analysis → Private vulnerability reporting. Issue templates already link to this.

### 6.2 Add yourself as the maintainer

The current `.github/ISSUE_TEMPLATE/config.yml` points to `aleksbuss/orchestra`. If you used a different repo name, update those URLs:

```bash
# Only if you renamed away from "orchestra"
sed -i '' 's|aleksbuss/orchestra|aleksbuss/YOUR_REPO_NAME|g' .github/ISSUE_TEMPLATE/config.yml
git commit -am "docs: fix issue-template URLs"
git push
```

---

## Step 7 — Public announcement (30 minutes) 👤

### 7.1 Show HN — submission draft (copy-paste-ready)

**Title** (75 char max — currently 71):

```
Show HN: Orchestra – local-first AI agent workspace with Mixture-of-Agents
```

**URL**: `https://github.com/aleksbuss/orchestra`

**Optional text** (Hacker News allows but doesn't require body text on Show HN; recommend keeping it short):

```
Hi HN — Orchestra is a self-hosted AI agent workspace I've been building
as a pet project. It runs on your laptop (or a small VPS), connects to
any OpenAI-compatible provider (OpenRouter, Ollama, Anthropic, Google),
and gives you a chat UI backed by a team of cooperating agents instead
of a single model.

Two design questions I wanted to explore:

(1) Can Mixture-of-Agents be made *dynamic*? Instead of fixed roles, the
Router reads each prompt and generates 3-5 hyper-specialized personas on
the fly. One slot is always a Skeptic that fact-checks the others in
parallel.

(2) What does "local-first" really mean for AI workspaces? Orchestra
uses JSON-on-disk for storage and SSE for realtime — no Redis, no
Postgres, no external services. You own your data; tar your data/ dir
and the entire project history is portable.

Stack: Next.js 15, TypeScript strict, Vercel AI SDK 5. About 1400
tests. The POST_MORTEMS.md registry documents every architectural bug
I made along the way and how the regression is now pinned — that part
is the actual project, the rest is implementation detail.

Honest about scope: alpha quality, single-tenant only, not horizontally
scalable. See the "Tradeoffs" section in docs/ARCHITECTURE.md.

Hard-forked from Eggent and substantially extended; attribution and
per-bundled-skill licensing in NOTICE.md.

Curious what you'd want from a tool like this. PRs welcome but I can't
promise rapid review.
```

Submit at: https://news.ycombinator.com/submit

**Timing**: Tuesday–Thursday, 7:00–9:00 AM PT (10:00 AM–12:00 PM ET, ~17:00–19:00 Riga time) gets the most front-page exposure. Avoid Mondays (busy queue) and weekends (low traffic).

### 7.2 LinkedIn / Twitter snippet (optional but high-value for job search)

```
Just open-sourced Orchestra — a local-first AI agent workspace I built
as a pet project to explore dynamic Mixture-of-Agents orchestration.

Highlights:
• Dynamic persona generation (no fixed agent roles)
• JSON-on-disk storage, SSE realtime layer, no external services
• ~1400 tests + a public POST_MORTEMS registry documenting every
  architectural bug found in development
• Next.js 15 + TypeScript strict + Vercel AI SDK 5

Repo: https://github.com/aleksbuss/orchestra

Looking for [your-target-role] opportunities — message me if interesting.
```

### 7.3 Reddit (optional)

Subreddits that fit:

- `/r/LocalLLaMA` — most receptive to self-hosted AI tools, very engaged
- `/r/SideProject` — generic pet-project showcase, broad audience
- `/r/programming` — only if you frame it as a TypeScript/Next.js architecture exploration

Don't cross-post the same text — each subreddit has its own etiquette. Read 5-10 top posts before submitting.

---

## After launch — what to expect

- **First 6 hours**: most traffic if you hit HN front page. Most clones come from here. Watch GitHub Stars + Discussions for early questions.
- **First week**: 1-3 issues filed. Triage realistically — for a pet project on alpha quality, "this doesn't work on Windows" is a known limitation, not a P0.
- **First month**: real interest tapers, search-engine traffic starts to dominate. Now's the time to polish a single feature based on early feedback rather than chase every issue.

For job search:
- The repo + README + ARCHITECTURE.md is the artifact.
- Pin it to your GitHub profile (`Profile → Pin → orchestra`).
- Add it to LinkedIn under "Projects" with a link.
- If you get a recruiter conversation, the `POST_MORTEMS.md` registry is your strongest signal — it shows engineering taste better than any test count.

Good luck. 🚀

---

*This checklist is itself a deliverable — feel free to delete it from the repo after launch, or keep it as a record of the release process.*
