#!/usr/bin/env bash
set -euo pipefail

APP_NAME="aisevak"
APP_DIR="${AISEVAK_APP_DIR:-/opt/${APP_NAME}}"
WORKSPACE_DIR="${AISEVAK_WORKSPACE_DIR:-/srv/${APP_NAME}}"
RUNNER_USER="aisevak"
RUNNER_SHELL="/bin/bash"
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
POSTGRES_IMAGE="postgres:18"
POSTGRES_LEGACY_MOUNT="/var/lib/postgresql/data"
POSTGRES_PARENT_MOUNT="/var/lib/postgresql"
POSTGRES_DATA_DIR="/var/lib/postgresql/18/docker"
POSTGRES_MIGRATION_MARKER=".aisevak-postgres-layout-v18"
DATABASE_BACKUP_FILE=""

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
  useradd --system --create-home --shell "${RUNNER_SHELL}" "${RUNNER_USER}"
else
  # Codex PTY-backed and background terminal commands need a real shell. The
  # system account remains password-locked and is not granted SSH access.
  usermod --shell "${RUNNER_SHELL}" "${RUNNER_USER}"
fi

log "Creating directories"
mkdir -p "${APP_DIR}" "${RELEASES_DIR}" "${BACKUP_DIR}"
install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" "${WORKSPACE_DIR}"
install -d -o "${RUNNER_USER}" -g "${RUNNER_USER}" \
  "${WORKSPACE_DIR}/workspaces" \
  "${WORKSPACE_DIR}/workspaces/github" \
  "${WORKSPACE_DIR}/codex-homes" \
  "${WORKSPACE_DIR}/skills" \
  "${WORKSPACE_DIR}/worktrees"
# Older API releases created Codex homes as root from inside the container.
# The host-native runner is the only process that writes their runtime files.
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${WORKSPACE_DIR}/codex-homes"
# The API and host runner both maintain the shared installed-skill catalog.
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${WORKSPACE_DIR}/skills"

require_command docker "Docker is not installed. Install Docker Engine first: https://docs.docker.com/engine/install/ubuntu/"
require_command rsync "rsync is required to stage releases."
require_command node "Node.js is required to build the host runner and generate secrets."

if ! command_exists git || ! command_exists gh; then
  log "Installing Git and GitHub CLI for repository projects"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git gh
fi
require_command git "Git is required for project workspaces."
require_command gh "GitHub CLI is required for GitHub authentication and project imports."

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

compose_release() {
  docker compose -p "${COMPOSE_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${RELEASE_DIR}/docker-compose.yml" "$@"
}

backup_database() {
  local required="${1:-${AISEVAK_REQUIRE_BACKUP:-0}}"

  if [[ "${AISEVAK_SKIP_BACKUP:-0}" == "1" ]]; then
    if [[ "${required}" == "1" ]]; then
      echo "Error: A required database backup cannot be skipped." >&2
      return 1
    fi
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
    if [[ "${required}" == "1" ]]; then
      echo "Error: Postgres is not running, so a required backup could not be created." >&2
      return 1
    fi
    log "Postgres is not running; skipping database backup"
    return
  fi

  if ! docker inspect -f '{{.State.Running}}' "${postgres_container}" 2>/dev/null | grep -q true; then
    if [[ "${required}" == "1" ]]; then
      echo "Error: Postgres container exists but is not running, so a required backup could not be created." >&2
      return 1
    fi
    log "Postgres container is not running; skipping database backup"
    return
  fi

  if ! command_exists gzip; then
    echo "Error: gzip is required to create compressed database backups." >&2
    return 1
  fi

  DATABASE_BACKUP_FILE="${BACKUP_DIR}/postgres-${TIMESTAMP}.sql.gz"
  log "Backing up Postgres to ${DATABASE_BACKUP_FILE}"
  if compose_current exec -T postgres pg_dump -U aisevak -d aisevak | gzip > "${DATABASE_BACKUP_FILE}"; then
    chmod 0600 "${DATABASE_BACKUP_FILE}"
  else
    rm -f "${DATABASE_BACKUP_FILE}"
    DATABASE_BACKUP_FILE=""
    if [[ "${required}" == "1" ]]; then
      echo "Error: Database backup failed." >&2
      return 1
    fi
    log "Database backup failed; continuing because AISEVAK_REQUIRE_BACKUP is not set"
  fi
}

container_volume_name_at() {
  local container="$1"
  local destination="$2"

  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"${destination}\"}}{{if eq .Type \"volume\"}}{{.Name}}{{end}}{{end}}{{end}}" "${container}"
}

container_is_running() {
  local container="$1"

  [[ -n "${container}" ]] && docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null | grep -q true
}

compose_service_is_running() {
  local service="$1"
  local container

  container="$(compose_current ps -a -q "${service}" 2>/dev/null || true)"
  container_is_running "${container}"
}

target_volume_has_migration_marker() {
  local volume_name="$1"

  docker run --rm \
    --mount "type=volume,source=${volume_name},target=/target,readonly" \
    --entrypoint bash \
    "${POSTGRES_IMAGE}" \
    -ceu 'test -s "/target/$1"' -- "${POSTGRES_MIGRATION_MARKER}"
}

target_volume_is_empty() {
  local volume_name="$1"

  docker run --rm \
    --mount "type=volume,source=${volume_name},target=/target,readonly" \
    --entrypoint bash \
    "${POSTGRES_IMAGE}" \
    -ceu 'test -z "$(find /target -mindepth 1 -maxdepth 1 -print -quit)"'
}

volume_cluster_info_at() {
  local volume_name="$1"
  local relative_path="$2"

  docker run --rm \
    --mount "type=volume,source=${volume_name},target=/target,readonly" \
    --entrypoint bash \
    "${POSTGRES_IMAGE}" \
    -ceu '
      data_dir="/target/$1"
      test -s "$data_dir/PG_VERSION"
      system_identifier="$(pg_controldata "$data_dir" | sed -n "s/^Database system identifier:[[:space:]]*//p")"
      test -n "$system_identifier"
      printf "%s|%s" "$(cat "$data_dir/PG_VERSION")" "$system_identifier"
    ' -- "${relative_path}"
}

mark_existing_structured_volume() {
  local volume_name="$1"
  local postgres_container="$2"

  docker run --rm \
    --mount "type=volume,source=${volume_name},target=/target" \
    --entrypoint bash \
    "${POSTGRES_IMAGE}" \
    -ceu '
      data_dir="/target/18/docker"
      marker="/target/$1"
      test "$(cat "$data_dir/PG_VERSION")" = "18"
      pg_controldata "$data_dir" | grep -Eq "Database cluster state:[[:space:]]+shut down"
      printf "postgres-major=18\nsource-container=%s\nbackup=%s\n" "$2" "$3" > "$marker"
    ' -- "${POSTGRES_MIGRATION_MARKER}" "${postgres_container}" "$(basename "${DATABASE_BACKUP_FILE}")"
}

restore_quiesced_services() {
  local postgres_was_running="$1"
  local api_was_running="$2"
  local web_was_running="$3"
  local runner_was_running="$4"

  log "Restoring services after the aborted Postgres migration"
  if [[ "${postgres_was_running}" == "1" ]]; then
    compose_current start postgres || true
  fi
  if [[ "${api_was_running}" == "1" ]]; then
    compose_current start api || true
  fi
  if [[ "${web_was_running}" == "1" ]]; then
    compose_current start web || true
  fi
  if [[ "${runner_was_running}" == "1" ]]; then
    systemctl start aisevak-runner.service || true
  fi
}

wait_for_release_postgres() {
  local postgres_container
  local status
  local attempt

  for ((attempt = 1; attempt <= 60; attempt += 1)); do
    postgres_container="$(compose_release ps -a -q postgres 2>/dev/null || true)"
    if [[ -n "${postgres_container}" ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${postgres_container}" 2>/dev/null || true)"
      if [[ "${status}" == "healthy" ]]; then
        return 0
      fi
      if [[ "${status}" == "exited" || "${status}" == "dead" ]]; then
        return 1
      fi
    fi
    sleep 2
  done

  return 1
}

migrate_postgres_volume_layout() {
  local postgres_container="$1"
  local target_volume="$2"
  local source_pgdata
  local source_major
  local source_system_identifier
  local target_cluster_info
  local target_major
  local target_system_identifier
  local target_layout="copy"
  local source_control_checksum
  local target_control_checksum
  local postgres_was_running=0
  local api_was_running=0
  local web_was_running=0
  local runner_was_running=0

  if ! container_is_running "${postgres_container}"; then
    fail "The legacy Postgres container is not running. Start it and retry so its data can be migrated safely."
  fi

  source_pgdata="$(docker exec "${postgres_container}" sh -ceu 'printf "%s" "$PGDATA"')"
  source_major="$(docker exec "${postgres_container}" sh -ceu 'cat "$PGDATA/PG_VERSION"')"
  source_system_identifier="$(docker exec "${postgres_container}" sh -ceu 'pg_controldata "$PGDATA" | sed -n "s/^Database system identifier:[[:space:]]*//p"')"
  if [[ "${source_pgdata}" != "${POSTGRES_DATA_DIR}" || "${source_major}" != "18" ]]; then
    fail "Expected a PostgreSQL 18 cluster at ${POSTGRES_DATA_DIR}; found PGDATA=${source_pgdata}, PG_VERSION=${source_major}. Migrate this cluster manually before retrying."
  fi
  if [[ -z "${source_system_identifier}" ]]; then
    fail "Could not read the legacy PostgreSQL cluster identifier. Refusing to migrate an unverified data directory."
  fi

  if target_volume_has_migration_marker "${target_volume}"; then
    fail "The target Postgres volume already contains an Aisevak migration marker while the legacy container is still mounted. Refusing to overwrite either copy; inspect both clusters before retrying."
  fi
  target_cluster_info="$(volume_cluster_info_at "${target_volume}" "18/docker" 2>/dev/null || true)"
  if [[ -n "${target_cluster_info}" ]]; then
    target_major="${target_cluster_info%%|*}"
    target_system_identifier="${target_cluster_info#*|}"
    if [[ "${target_major}" != "18" || "${target_system_identifier}" != "${source_system_identifier}" ]]; then
      fail "The target Postgres volume contains a different cluster at 18/docker. Refusing to overwrite it."
    fi
    target_layout="structured"
  elif ! target_volume_is_empty "${target_volume}"; then
    fail "The target Postgres volume is not empty and does not contain the live cluster at 18/docker. Refusing to overwrite existing data during the mount migration."
  fi

  if compose_service_is_running postgres; then
    postgres_was_running=1
  fi
  if compose_service_is_running api; then
    api_was_running=1
  fi
  if compose_service_is_running web; then
    web_was_running=1
  fi
  if systemctl is-active --quiet aisevak-runner.service; then
    runner_was_running=1
  fi

  log "Quiescing database writers for the Postgres volume migration"
  if [[ "${runner_was_running}" == "1" ]]; then
    if ! systemctl stop aisevak-runner.service; then
      fail "Could not stop the host runner before the Postgres migration; the release was not activated."
    fi
  fi
  if ! compose_current stop api web; then
    restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
    fail "Could not stop the API and web services before the Postgres migration; the release was not activated."
  fi

  if ! backup_database 1; then
    restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
    fail "The required pre-migration database backup failed; the release was not activated."
  fi

  if ! compose_current stop postgres; then
    restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
    fail "Could not stop Postgres for a consistent volume migration; the release was not activated."
  fi

  if [[ "${target_layout}" == "structured" ]]; then
    log "Validating the existing PostgreSQL 18 cluster in the version-aware volume layout"
    if ! source_control_checksum="$(docker run --rm \
      --volumes-from "${postgres_container}" \
      --entrypoint sha256sum \
      "${POSTGRES_IMAGE}" \
      "${source_pgdata}/global/pg_control" | sed 's/[[:space:]].*//')"; then
      restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
      fail "Could not checksum the stopped source cluster; the legacy services were restarted and the release was not activated."
    fi
    if ! target_control_checksum="$(docker run --rm \
      --mount "type=volume,source=${target_volume},target=/target,readonly" \
      --entrypoint sha256sum \
      "${POSTGRES_IMAGE}" \
      /target/18/docker/global/pg_control | sed 's/[[:space:]].*//')"; then
      restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
      fail "Could not checksum the target cluster; the legacy services were restarted and the release was not activated."
    fi
    if [[ -z "${source_control_checksum}" || "${source_control_checksum}" != "${target_control_checksum}" ]]; then
      restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
      fail "The source and target Postgres control files differ after shutdown. Refusing to switch to a stale or unrelated target cluster."
    fi
    if ! mark_existing_structured_volume "${target_volume}" "${postgres_container}"; then
      restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
      fail "The existing version-aware Postgres cluster failed validation; the legacy services were restarted and the release was not activated."
    fi
  else
    log "Copying the stopped PostgreSQL 18 cluster into ${POSTGRES_DATA_DIR} on volume ${target_volume}"
    if ! docker run --rm \
      --volumes-from "${postgres_container}" \
      --entrypoint tar \
      "${POSTGRES_IMAGE}" \
      -C "${source_pgdata}" -cf - . \
      | docker run --rm -i \
      --mount "type=volume,source=${target_volume},target=/target" \
      --entrypoint bash \
      "${POSTGRES_IMAGE}" \
      -ceu '
        target_dir="/target/18/docker"
        stage_dir="/target/18/.aisevak-migrating-$1"
        marker="/target/$2"
        cleanup() {
          rm -rf -- "$stage_dir"
          rmdir /target/18 2>/dev/null || true
        }
        trap cleanup EXIT

        test -z "$(find /target -mindepth 1 -maxdepth 1 -print -quit)"
        test ! -e "$target_dir"
        mkdir -p "$(dirname "$stage_dir")" "$stage_dir"
        tar -C "$stage_dir" -xf -
        test -s "$stage_dir/PG_VERSION"
        test "$(cat "$stage_dir/PG_VERSION")" = "18"
        pg_controldata "$stage_dir" | grep -Eq "Database cluster state:[[:space:]]+shut down"
        mv "$stage_dir" "$target_dir"
        printf "postgres-major=18\nsource-container=%s\nbackup=%s\n" "$3" "$4" > "$marker"
        trap - EXIT
      ' -- "${TIMESTAMP}" "${POSTGRES_MIGRATION_MARKER}" "${postgres_container}" "$(basename "${DATABASE_BACKUP_FILE}")"; then
      restore_quiesced_services "${postgres_was_running}" "${api_was_running}" "${web_was_running}" "${runner_was_running}"
      fail "Postgres volume migration failed; the legacy services were restarted and the release was not activated."
    fi
  fi

  log "Starting PostgreSQL with the version-aware volume layout"
  if ! compose_release up -d postgres; then
    fail "The data migration completed, but Postgres could not be recreated with the new mount. The release was not activated; the backup is ${DATABASE_BACKUP_FILE}."
  fi
  if ! wait_for_release_postgres; then
    fail "The migrated Postgres container did not become healthy. The release was not activated; the backup is ${DATABASE_BACKUP_FILE}."
  fi
  if ! compose_release exec -T postgres psql -v ON_ERROR_STOP=1 -U aisevak -d aisevak -Atqc 'SELECT 1' | grep -qx 1; then
    fail "The migrated database failed its verification query. The release was not activated; the backup is ${DATABASE_BACKUP_FILE}."
  fi

  log "Postgres volume migration completed successfully"
}

migrate_postgres_volume_if_needed() {
  local postgres_container
  local legacy_volume
  local parent_volume

  if [[ ! -f "${CURRENT_DIR}/docker-compose.yml" ]]; then
    return
  fi
  if ! grep -Eq 'postgres-data:/var/lib/postgresql/data([[:space:]]|$)' "${CURRENT_DIR}/docker-compose.yml"; then
    return
  fi
  if ! grep -Eq 'postgres-data:/var/lib/postgresql([[:space:]]|$)' "${RELEASE_DIR}/docker-compose.yml"; then
    return
  fi

  postgres_container="$(compose_current ps -a -q postgres 2>/dev/null || true)"
  if [[ -z "${postgres_container}" ]]; then
    fail "The active release uses the legacy Postgres mount, but its container could not be found. Refusing to activate the new mount without migrating the existing data."
  fi

  legacy_volume="$(container_volume_name_at "${postgres_container}" "${POSTGRES_LEGACY_MOUNT}")"
  parent_volume="$(container_volume_name_at "${postgres_container}" "${POSTGRES_PARENT_MOUNT}")"
  if [[ -n "${legacy_volume}" ]]; then
    migrate_postgres_volume_layout "${postgres_container}" "${legacy_volume}"
    return
  fi

  if [[ -n "${parent_volume}" ]] && target_volume_has_migration_marker "${parent_volume}"; then
    log "Postgres already uses the migrated version-aware volume layout"
    return
  fi

  fail "The active release uses the legacy Postgres mount, but the container's data mounts are unexpected. Refusing to activate the new mount automatically."
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
install -d -m 0755 "${RELEASE_DIR}"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .env \
  --exclude .env.local \
  --exclude .DS_Store \
  "${SOURCE_DIR}/" "${RELEASE_DIR}/"
# rsync preserves the source directory mode. Deployment staging directories
# are intentionally private, but the host runner must be able to traverse the
# activated release as its unprivileged service user.
chmod 0755 "${RELEASE_DIR}"
printf "%s\n" "${GIT_SHA}" > "${RELEASE_DIR}/REVISION"

if [[ ! -f "${ENV_FILE}" ]]; then
  log "Creating ${ENV_FILE}"
  SECRET_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  COOKIE_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  cp "${RELEASE_DIR}/.env.example" "${ENV_FILE}"
  sed -i "s#replace-with-32-byte-base64-key#${SECRET_KEY}#g" "${ENV_FILE}"
  sed -i "s#replace-with-at-least-32-random-bytes#${COOKIE_SECRET}#g" "${ENV_FILE}"
  sed -i "s#^MANAGED_ROOT=.*#MANAGED_ROOT=${WORKSPACE_DIR}#g" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
fi

ln -sf "${ENV_FILE}" "${RELEASE_DIR}/.env"

log "Installing workspace dependencies"
cd "${RELEASE_DIR}"
pnpm install --frozen-lockfile=false

log "Building release"
pnpm build

migrate_postgres_volume_if_needed
if [[ -z "${DATABASE_BACKUP_FILE}" ]]; then
  if ! backup_database; then
    fail "Database backup failed."
  fi
fi

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
