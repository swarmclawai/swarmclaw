#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:3456"
COMPOSE_ARGS=(-f compose.subscription.yml)

if [[ -f "$REPO_DIR/.env.local" ]]; then
  COMPOSE_ARGS=(--env-file .env.local "${COMPOSE_ARGS[@]}")
fi

cd "$REPO_DIR"

echo "Starting SwarmClaw..."
echo "Repository: $REPO_DIR"
echo "URL: $URL"
echo

docker compose "${COMPOSE_ARGS[@]}" up -d

for _ in {1..60}; do
  if curl -fsS "$URL/api/healthz" >/dev/null 2>&1; then
    echo "SwarmClaw is healthy. Opening $URL"
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL" >/dev/null 2>&1 &
    fi
    exit 0
  fi
  sleep 1
done

echo "SwarmClaw started, but health check did not pass within 60 seconds."
echo "Check logs with:"
echo "  cd \"$REPO_DIR\""
echo "  docker compose ${COMPOSE_ARGS[*]} logs --tail=120 swarmclaw"
exit 1
