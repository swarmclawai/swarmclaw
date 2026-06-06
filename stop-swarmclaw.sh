#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:3456"
COMPOSE_ARGS=(-f compose.subscription.yml)

if [[ -f "$REPO_DIR/.env.local" ]]; then
  COMPOSE_ARGS=(--env-file .env.local "${COMPOSE_ARGS[@]}")
fi

cd "$REPO_DIR"

echo "Stopping SwarmClaw..."
docker compose "${COMPOSE_ARGS[@]}" down
echo
echo "SwarmClaw stopped. You can close this window."
if [[ -t 0 ]]; then
  read -r -p "Press Enter to close..." _
fi
