#!/usr/bin/env bash
set -euo pipefail

APP_NAME="aisevak"
APP_DIR="${AISEVAK_APP_DIR:-/opt/${APP_NAME}}"
WORKSPACE_DIR="${AISEVAK_WORKSPACE_DIR:-/srv/${APP_NAME}}"
RUNNER_USER="aisevak"
CURRENT_DIR="${APP_DIR}/current"
ENV_FILE="${APP_DIR}/.env"
RELEASES_DIR="${APP_DIR}/releases"
BACKUP_DIR="${APP_DIR}/backups"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
GIT_SHA="$(git -C "${SOURCE_DIR}" rev-parse --short HEAD 2>/dev/null || echo manual)"
RELEASE_DIR="${RELEASES_DIR}/${TIMESTAMP}-${GIT_SHA}"
COMPOSE_PROJECT_NAME="${AISEVAK_COMPOSE_PROJECT_NAME:-current}"
RELEASES_TO_KEEP="${AISEVAK_RELEASES_TO_KEEP:-5}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo."
  exit 1
fi

log() {
  printf "\n==> %s\n" "$*"
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! command_exists "$1"; then
    fail "$2"
  fi
}

if ! id "${RUNNER_USER}" >/dev/null 2>&1; then
  log "Creating ${RUNNER_USER} service user"
  useradd --system --create-home --shell /usr/sbin/nologin "${RUNNER_USER}"
fi

log "Creating directories"
mkdir -p "${APP_DIR}" "${RELEASES_DIR}" "${BACKUP_DIR}"
install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" "${WORKSPACE_DIR}"
install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" \
  "${WORKSPACE_DIR}/workspaces" \
  "${WORKSPACE_DIR}/workspaces/github" \
  "${WORKSPACE_DIR}/codex-homes" \
  "${WORKSPACE_DIR}/worktrees"

require_command docker "Docker is not installed. Install Docker Engine first: https://docs.docker.com/engine/install/ubuntu/"
require_command rsync "rsync is required to stage releases."
require_command node "Node.js is required to build the host runner and generate secrets."

if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose plugin is not installed. Install it first: https://docs.docker.com/compose/install/linux/"
fi

if ! command_exists pnpm; then
  if command_exists corepack; then
    corepack enable
  else
    fail "pnpm/corepack is required for the host runner."
  fi
fi

if ! command_exists pnpm; then
  fail "pnpm is still unavailable after attempting to enable corepack."
fi

compose_current() {
  docker compose -p "${COMPOSE_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${CURRENT_DIR}/docker-compose.yml" "$@"
}

backup_database() {
  if [[ "${AISEVAK_SKIP_BACKUP:-0}" == "1" ]]; then
    log "Skipping database backup because AISEVAK_SKIP_BACKUP=1"
    return
  fi

  if [[ ! -f "${CURRENT_DIR}/docker-compose.yml" ]]; then
    log "No active release yet; skipping database backup"
    return
  fi

  local postgres_container
  postgres_container="$(compose_current ps -q postgres 2>/dev/null || true)"
  if [[ -z "${postgres_container}" ]]; then
    if [[ "${AISEVAK_REQUIRE_BACKUP:-0}" == "1" ]]; then
      fail "Postgres is not running, so a required backup could not be created."
    fi
    log "Postgres is not running; skipping database backup"
    return
  fi

  if ! docker inspect -f '{{.State.Running}}' "${postgres_container}" 2>/dev/null | grep -q true; then
    if [[ "${AISEVAK_REQUIRE_BACKUP:-0}" == "1" ]]; then
      fail "Postgres container exists but is not running, so a required backup could not be created."
    fi
    log "Postgres container is not running; skipping database backup"
    return
  fi

  require_command gzip "gzip is required to create compressed database backups."

  local backup_file="${BACKUP_DIR}/postgres-${TIMESTAMP}.sql.gz"
  log "Backing up Postgres to ${backup_file}"
  if compose_current exec -T postgres pg_dump -U aisevak -d aisevak | gzip > "${backup_file}"; then
    chmod 0600 "${backup_file}"
  else
    rm -f "${backup_file}"
    if [[ "${AISEVAK_REQUIRE_BACKUP:-0}" == "1" ]]; then
      fail "Database backup failed."
    fi
    log "Database backup failed; continuing because AISEVAK_REQUIRE_BACKUP is not set"
  fi
}

prune_releases() {
  if [[ "${RELEASES_TO_KEEP}" -le 0 ]]; then
    return
  fi

  local current_target
  current_target="$(readlink "${CURRENT_DIR}" 2>/dev/null || true)"

  find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +"$((RELEASES_TO_KEEP + 1))" | while read -r old_release; do
    if [[ "${old_release}" == "${current_target}" ]]; then
      continue
    fi
    rm -rf "${old_release}"
  done
}

log "Staging release ${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .env \
  --exclude .env.local \
  --exclude .DS_Store \
  "${SOURCE_DIR}/" "${RELEASE_DIR}/"
printf "%s\n" "${GIT_SHA}" > "${RELEASE_DIR}/REVISION"

if [[ ! -f "${ENV_FILE}" ]]; then
  log "Creating ${ENV_FILE}"
  SECRET_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  COOKIE_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  cp "${RELEASE_DIR}/.env.example" "${ENV_FILE}"
  sed -i "s#replace-with-32-byte-base64-key#${SECRET_KEY}#g" "${ENV_FILE}"
  sed -i "s#replace-with-at-least-32-random-bytes#${COOKIE_SECRET}#g" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
fi

ln -sf "${ENV_FILE}" "${RELEASE_DIR}/.env"

log "Installing workspace dependencies"
cd "${RELEASE_DIR}"
pnpm install --frozen-lockfile=false

log "Building release"
pnpm build

backup_database

if [[ -e "${CURRENT_DIR}" && ! -L "${CURRENT_DIR}" ]]; then
  log "Archiving legacy current directory"
  mv "${CURRENT_DIR}" "${RELEASES_DIR}/legacy-current-${TIMESTAMP}"
fi

log "Activating release"
ln -sfn "${RELEASE_DIR}" "${CURRENT_DIR}.next"
mv -Tf "${CURRENT_DIR}.next" "${CURRENT_DIR}"

log "Starting Docker services"
cd "${CURRENT_DIR}"
docker compose -p "${COMPOSE_PROJECT_NAME}" --env-file "${ENV_FILE}" up -d --build postgres api web

log "Installing host runner service"
cp "${CURRENT_DIR}/apps/runner/aisevak-runner.service" /etc/systemd/system/aisevak-runner.service
systemctl daemon-reload
systemctl enable aisevak-runner.service
systemctl restart aisevak-runner.service

prune_releases

echo "Aisevak is ready on http://$(hostname -I | awk '{print $1}'):8080"
