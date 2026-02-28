#!/usr/bin/env bash
set -euo pipefail

REPO="${SWARMCLAW_REPO:-swarmclawai/swarmclaw}"
INSTALL_DIR="${SWARMCLAW_DIR:-$HOME/swarmclaw}"
REQUESTED_VERSION="${SWARMCLAW_VERSION:-latest}"

log() {
  printf '[install] %s\n' "$1"
}

fail() {
  printf '[install] ERROR: %s\n' "$1" >&2
  exit 1
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

resolve_latest_release_tag() {
  local api_url="https://api.github.com/repos/${REPO}/releases/latest"
  local tag

  if command -v curl >/dev/null 2>&1; then
    tag="$(curl -fsSL "$api_url" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
  else
    tag=""
  fi

  if [[ -z "$tag" ]]; then
    tag="$(git ls-remote --tags --sort='-v:refname' "https://github.com/${REPO}.git" 'v*' 2>/dev/null | awk -F'/' 'NR==1 { print $3 }')"
  fi

  printf '%s' "$tag"
}

checkout_target() {
  local target="$1"

  if [[ "$target" == "main" ]]; then
    git checkout main >/dev/null 2>&1 || git checkout -B main origin/main
    git pull --ff-only origin main
    return
  fi

  if ! [[ "$target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
    fail "Resolved version is not a valid release tag: $target"
  fi

  git fetch --tags origin --quiet
  if ! git rev-parse "refs/tags/${target}" >/dev/null 2>&1; then
    fail "Release tag not found: ${target}"
  fi
  git checkout -B stable "refs/tags/${target}"
}

main() {
  need_cmd git
  need_cmd node
  need_cmd npm
  need_cmd sed
  need_cmd awk

  local target="$REQUESTED_VERSION"
  if [[ "$target" == "latest" ]]; then
    target="$(resolve_latest_release_tag)"
    if [[ -z "$target" ]]; then
      log "No stable release tag found yet. Falling back to main branch."
      target="main"
    fi
  fi

  log "Installing ${REPO} (${target}) into ${INSTALL_DIR}"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "Existing install detected; updating repository metadata."
    git -C "$INSTALL_DIR" remote set-url origin "https://github.com/${REPO}.git"
    git -C "$INSTALL_DIR" fetch --all --tags --prune --quiet
  else
    rm -rf "$INSTALL_DIR"
    git clone "https://github.com/${REPO}.git" "$INSTALL_DIR"
  fi

  cd "$INSTALL_DIR"
  checkout_target "$target"

  # Install Deno (sandbox runtime)
  if ! command -v deno >/dev/null 2>&1; then
    log "Installing Deno (sandbox runtime)..."
    curl -fsSL https://deno.land/install.sh | sh
    export DENO_INSTALL="$HOME/.deno"
    export PATH="$DENO_INSTALL/bin:$PATH"
  fi

  log "Installing dependencies"
  npm install

  log "Bootstrapping local environment"
  npm run setup:easy -- --skip-install

  cat <<EOF

SwarmClaw installed successfully.

Next steps:
1. cd "$INSTALL_DIR"
2. npm run dev
3. Open http://localhost:3456

For updates later:
- npm run update:easy
EOF
}

main "$@"

