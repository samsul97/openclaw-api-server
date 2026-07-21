#!/bin/bash
# Delete exactly one validated OpenClaw client Linux user/home and service.

set -e
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

NAME="${1}"
if [[ ! "$NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "Invalid client name"
  exit 1
fi

SERVICE_NAME="openclaw-${NAME}-gateway.service"
LINUX_USER="openclaw-${NAME}"
HOME_DIR="/home/${LINUX_USER}"
STATE_DIR="${HOME_DIR}/.openclaw"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"

if [[ "$LINUX_USER" == "root" || "$HOME_DIR" == "/root" || "$HOME_DIR" == "/home" ]]; then
  echo "Forbidden target"
  exit 1
fi
if [[ ! -f "${STATE_DIR}/openclaw.json" ]]; then
  echo "Client '${NAME}' not found in validated home layout"
  exit 1
fi

read -r CONFIRM
if [[ "$CONFIRM" != "$NAME" ]]; then
  echo "Confirmation mismatch"
  exit 1
fi

systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f -- "${SERVICE_FILE}"
systemctl daemon-reload

if id "${LINUX_USER}" >/dev/null 2>&1; then
  # A per-user systemd manager can survive after the gateway stops and makes
  # userdel fail after it has already removed the home directory. Terminate
  # that session first so deletion remains atomic from the caller's view.
  loginctl disable-linger "${LINUX_USER}" 2>/dev/null || true
  loginctl terminate-user "${LINUX_USER}" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    pgrep -u "${LINUX_USER}" >/dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -u "${LINUX_USER}" >/dev/null 2>&1; then
    pkill -TERM -u "${LINUX_USER}" 2>/dev/null || true
    sleep 1
  fi
  if pgrep -u "${LINUX_USER}" >/dev/null 2>&1; then
    pkill -KILL -u "${LINUX_USER}" 2>/dev/null || true
  fi
  userdel -r "${LINUX_USER}"
elif [[ -d "${HOME_DIR}" ]]; then
  rm -rf -- "${HOME_DIR}"
fi

echo "Client '${NAME}' deleted"
