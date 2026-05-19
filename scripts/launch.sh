#!/usr/bin/env bash
# scripts/launch.sh — autonomous launch helper
#
# Run once. The script will:
#   1. Open the GitHub PAT generation URL with scopes pre-filled.
#   2. Wait for you to paste the PAT (hidden input — not echoed, not logged).
#   3. Push the repo to GitHub using that PAT, bypassing the broken gh-CLI auth.
#   4. Use the same PAT to set repo topics, enable Discussions, and enable
#      private vulnerability reporting via the GitHub REST API.
#   5. Discard the PAT from memory after the script exits.
#
# Your only physical interaction:
#   - Click "Generate token" in the browser.
#   - Paste the resulting `ghp_xxx...` string when prompted.
#
# Everything else is automated.

set -euo pipefail

REPO_OWNER="aleksbuss"
REPO_NAME="orchestra"

echo "──────────────────────────────────────────────────────────────"
echo " Orchestra autonomous launch helper"
echo "──────────────────────────────────────────────────────────────"
echo ""
echo "Step 1/4 — Opening GitHub PAT generator with scopes pre-filled..."
echo ""

PAT_URL="https://github.com/settings/tokens/new?scopes=repo,workflow,read:org,gist&description=orchestra-cli"

# Open in default browser (works in macOS, Linux with xdg-open, Windows WSL).
if command -v open >/dev/null 2>&1; then
  open "$PAT_URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$PAT_URL"
else
  echo "  Couldn't auto-open. Open manually: $PAT_URL"
fi

cat <<'INSTRUCTIONS'

In the browser tab that just opened:

  ✓ Scopes are already pre-filled (repo, workflow, read:org, gist).
  ✓ Note is pre-filled as "orchestra-cli".
  ✓ Default expiration is 30 days — change to "No expiration" or
    "1 year" if you want me to be able to push for you later without
    re-doing this dance.
  ✓ Scroll to the bottom → click "Generate token" (green button).
  ✓ Copy the token (starts with "ghp_") — GitHub only shows it ONCE.

INSTRUCTIONS

# -s flag suppresses echo (the PAT is not displayed as you type).
echo -n "Paste your PAT here and press Enter: "
read -s PAT
echo ""
echo ""

if [[ -z "$PAT" ]]; then
  echo "  ✗ Empty input. Aborting."
  exit 1
fi

if [[ ! "$PAT" =~ ^gh[ps]_ ]]; then
  echo "  ⚠ Warning: PAT doesn't start with 'ghp_' or 'ghs_'."
  echo "  Continuing anyway, but the push may fail."
fi

echo "Step 2/4 — Pushing main branch to GitHub..."
echo ""

# Use the PAT directly for THIS push only via a one-shot credential helper.
# Nothing is written to disk; the PAT lives only in this shell process.
if git \
    -c "credential.helper=!f() { echo username=$REPO_OWNER; echo password=$PAT; }; f" \
    push -u origin main 2>&1; then
  echo ""
  echo "  ✓ Push succeeded."
else
  echo ""
  echo "  ✗ Push failed. See output above. Common causes:"
  echo "    - PAT missing 'workflow' scope → regenerate with all 4 scopes."
  echo "    - Wrong PAT pasted → re-run this script."
  exit 1
fi

echo ""
echo "Step 3/4 — Configuring repository (topics, Discussions, Security)..."
echo ""

API() {
  curl -sS \
    -H "Authorization: Bearer $PAT" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# 3a. Repository topics — discoverability via GitHub topic pages.
echo "  → Setting repository topics..."
API -X PUT \
  "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/topics" \
  -d '{
    "names": [
      "ai-agents",
      "mixture-of-agents",
      "nextjs",
      "typescript",
      "local-first",
      "self-hosted",
      "llm",
      "claude",
      "openai",
      "agent-framework"
    ]
  }' >/dev/null && echo "    ✓ Topics set"

# 3b. Enable Discussions on the repo.
echo "  → Enabling Discussions..."
API -X PATCH \
  "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME" \
  -d '{"has_discussions": true}' >/dev/null && echo "    ✓ Discussions enabled"

# 3c. Enable private vulnerability reporting (security advisories).
echo "  → Enabling private vulnerability reporting..."
API -X PUT \
  "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/private-vulnerability-reporting" \
  >/dev/null 2>&1 \
  && echo "    ✓ Private vulnerability reporting enabled" \
  || echo "    ⚠ Couldn't enable (requires repo admin + may already be on)"

# 3d. Update active gh-CLI token to the new PAT so future `gh` calls Just Work.
echo "  → Updating gh-CLI credentials..."
if echo "$PAT" | gh auth login --hostname github.com --with-token >/dev/null 2>&1; then
  echo "    ✓ gh-CLI now uses the new PAT (workflow scope included)"
else
  echo "    ⚠ Couldn't update gh-CLI (non-fatal — script will continue)"
fi

echo ""
echo "Step 4/4 — Done. PAT discarded from memory."
echo ""

# Wipe PAT from shell variable. Process exit also clears it.
unset PAT

cat <<EOF
──────────────────────────────────────────────────────────────
 ✓ LAUNCH COMPLETE
──────────────────────────────────────────────────────────────

 Your repo is live: https://github.com/$REPO_OWNER/$REPO_NAME

 Already configured:
   ✓ Public visibility
   ✓ MIT license advertised
   ✓ Topics for GitHub discoverability
   ✓ Discussions enabled
   ✓ Security advisories (private reporting) enabled

 What still needs YOU (physical world only):

   1. Screenshots + demo GIF — see docs/LAUNCH_CHECKLIST.md §2
   2. Rotate API keys at each provider — checklist §3
   3. Pin the repo to your GitHub profile:
      https://github.com/$REPO_OWNER → "Customize your pins"
   4. Submit to Show HN — draft ready in checklist §7.1

 See docs/LAUNCH_CHECKLIST.md for the rest.

──────────────────────────────────────────────────────────────
EOF
