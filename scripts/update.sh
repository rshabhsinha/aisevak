#!/usr/bin/env bash
set -euo pipefail

BRANCH="${1:-${AISEVAK_DEPLOY_BRANCH:-main}}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [[ -z "${ROOT}" ]]; then
  echo "Run this from an Aisevak git checkout." >&2
  exit 1
fi

cd "${ROOT}"

if [[ "${AISEVAK_ALLOW_DIRTY:-0}" != "1" && -n "$(git status --porcelain)" ]]; then
  echo "Working tree has local changes. Commit, stash, or set AISEVAK_ALLOW_DIRTY=1." >&2
  exit 1
fi

git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

if [[ "${EUID}" -eq 0 ]]; then
  ./scripts/install.sh
else
  sudo ./scripts/install.sh
fi
