#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:1
export HOME=/tmp/swarmclaw-browser-home
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_CACHE_HOME="${HOME}/.cache"

CDP_PORT="${SWARMCLAW_BROWSER_CDP_PORT:-9222}"
VNC_PORT="${SWARMCLAW_BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${SWARMCLAW_BROWSER_NOVNC_PORT:-6080}"
HEADLESS="${SWARMCLAW_BROWSER_HEADLESS:-1}"
ENABLE_NOVNC="${SWARMCLAW_BROWSER_ENABLE_NOVNC:-1}"
ALLOW_NO_SANDBOX="${SWARMCLAW_BROWSER_NO_SANDBOX:-1}"
NOVNC_PASSWORD="${SWARMCLAW_BROWSER_NOVNC_PASSWORD:-}"

mkdir -p "${HOME}" "${HOME}/.chrome" "${XDG_CONFIG_HOME}" "${XDG_CACHE_HOME}"

Xvfb :1 -screen 0 1280x800x24 -ac -nolisten tcp &

CHROME_ARGS=(
  "--remote-debugging-address=127.0.0.1"
  "--user-data-dir=${HOME}/.chrome"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-background-networking"
  "--disable-features=TranslateUI"
  "--disable-breakpad"
  "--disable-crash-reporter"
  "--disable-extensions"
  "--no-zygote"
  "--metrics-recording-only"
)

if [[ "${HEADLESS}" == "1" ]]; then
  CHROME_ARGS+=("--headless=new")
fi

if [[ "${ALLOW_NO_SANDBOX}" == "1" ]]; then
  CHROME_ARGS+=(
    "--no-sandbox"
    "--disable-setuid-sandbox"
  )
fi

if [[ "${CDP_PORT}" -ge 65535 ]]; then
  CHROME_CDP_PORT="$((CDP_PORT - 1))"
else
  CHROME_CDP_PORT="$((CDP_PORT + 1))"
fi

CHROME_ARGS+=("--remote-debugging-port=${CHROME_CDP_PORT}")

chromium "${CHROME_ARGS[@]}" about:blank &

for _ in $(seq 1 60); do
  if curl -sS --max-time 1 "http://127.0.0.1:${CHROME_CDP_PORT}/json/version" >/dev/null; then
    break
  fi
  sleep 0.1
done

# Keep the public endpoint bound to all interfaces inside the container,
# while Docker publishes it to loopback on the host.
socat "TCP-LISTEN:${CDP_PORT},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${CHROME_CDP_PORT}" &

if [[ "${ENABLE_NOVNC}" == "1" && "${HEADLESS}" != "1" ]]; then
  if [[ -z "${NOVNC_PASSWORD}" ]]; then
    NOVNC_PASSWORD="$(< /proc/sys/kernel/random/uuid)"
    NOVNC_PASSWORD="${NOVNC_PASSWORD//-/}"
    NOVNC_PASSWORD="${NOVNC_PASSWORD:0:8}"
  fi
  NOVNC_PASSWD_FILE="${HOME}/.vnc/passwd"
  mkdir -p "${HOME}/.vnc"
  x11vnc -storepasswd "${NOVNC_PASSWORD}" "${NOVNC_PASSWD_FILE}" >/dev/null
  chmod 600 "${NOVNC_PASSWD_FILE}"
  x11vnc -display :1 -rfbport "${VNC_PORT}" -shared -forever -rfbauth "${NOVNC_PASSWD_FILE}" -localhost &
  websockify --web /usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" &
fi

wait -n
