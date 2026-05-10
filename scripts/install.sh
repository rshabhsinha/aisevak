#!/usr/bin/env bash
set -euo pipefail

APP_NAME="aisevak"
APP_DIR="/opt/${APP_NAME}"
WORKSPACE_DIR="/srv/${APP_NAME}"
RUNNER_USER="aisevak"
CURRENT_DIR="${APP_DIR}/current"
ENV_FILE="${APP_DIR}/.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo."
  exit 1
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

echo "Creating directories"
mkdir -p "${APP_DIR}" "${WORKSPACE_DIR}/workspaces/github" "${WORKSPACE_DIR}/codex-homes" "${WORKSPACE_DIR}/worktrees"

if ! id "${RUNNER_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${RUNNER_USER}"
fi

chown -R "${RUNNER_USER}:${RUNNER_USER}" "${WORKSPACE_DIR}"

if ! command_exists docker; then
  echo "Docker is not installed. Install Docker Engine first: https://docs.docker.com/engine/install/ubuntu/"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is not installed. Install it first: https://docs.docker.com/compose/install/linux/"
  exit 1
fi

if ! command_exists pnpm; then
  if command_exists corepack; then
    corepack enable
  else
    echo "pnpm/corepack is required for the host runner."
    exit 1
  fi
fi

echo "Copying application into ${CURRENT_DIR}"
rm -rf "${CURRENT_DIR}"
mkdir -p "${CURRENT_DIR}"
rsync -a --delete --exclude node_modules --exclude .git ./ "${CURRENT_DIR}/"

if [[ ! -f "${ENV_FILE}" ]]; then
  SECRET_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  COOKIE_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  cp "${CURRENT_DIR}/.env.example" "${ENV_FILE}"
  sed -i "s#replace-with-32-byte-base64-key#${SECRET_KEY}#g" "${ENV_FILE}"
  sed -i "s#replace-with-at-least-32-random-bytes#${COOKIE_SECRET}#g" "${ENV_FILE}"
fi

ln -sf "${ENV_FILE}" "${CURRENT_DIR}/.env"

echo "Installing workspace dependencies"
cd "${CURRENT_DIR}"
pnpm install --frozen-lockfile=false
pnpm build

echo "Starting Docker services"
docker compose --env-file "${ENV_FILE}" up -d --build postgres api web

echo "Installing host runner service"
cp "${CURRENT_DIR}/apps/runner/aisevak-runner.service" /etc/systemd/system/aisevak-runner.service
systemctl daemon-reload
systemctl enable aisevak-runner.service
systemctl restart aisevak-runner.service

echo "Aisevak is ready on http://$(hostname -I | awk '{print $1}'):8080"
