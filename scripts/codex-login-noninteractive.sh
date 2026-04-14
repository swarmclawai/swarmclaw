#!/usr/bin/env bash
# Helper to non-interactively login codex CLI using an API key.
# Usage:
#   OPENAI_API_KEY=sk-... $0
#   $0 sk-...
# This writes credentials to the current user's ~/.codex directory.
set -euo pipefail
KEY="${1:-}${OPENAI_API_KEY:-}"
if [ -z "${KEY}" ]; then
  echo "Usage: OPENAI_API_KEY=<key> ./codex-login-noninteractive.sh" >&2
  echo "   or: ./codex-login-noninteractive.sh <key>" >&2
  exit 2
fi
# Read key from arg or env and pipe to codex login
printf "%s" "${KEY}" | codex login --with-api-key
echo "codex login completed for user: $(whoami)"
