#!/usr/bin/env bash
set -euo pipefail

# Keep the native executable, sibling tool host and packaged resources together.
# New launches use one immutable bundle; existing processes retain their version.
native_binary="${1:?native Codex executable is required}"
harness_dir="${2:?shared harness directory is required}"
release_id="${3:?release identifier is required}"
[[ "$release_id" =~ ^[a-zA-Z0-9._-]+$ ]] || { echo 'Invalid Codex release identifier' >&2; exit 1; }
vendor_dir="$(cd "$(dirname "$native_binary")/.." && pwd -P)"
[[ -x "$vendor_dir/bin/codex" && -x "$vendor_dir/bin/codex-code-mode-host" ]] || {
  echo 'Codex runtime is incomplete: native executable or code-mode host is missing' >&2
  exit 1
}
[[ ! -d "$harness_dir/codex" ]] || { echo 'Codex launcher path is a directory' >&2; exit 1; }
mkdir -p "$harness_dir"
# Content identity avoids copying another runtime on every app deployment.
# Ignore timestamps and read permissions normalized for the API container.
runtime_digest() {
  node --input-type=module - "$1" <<'DIGEST'
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[2], hash = createHash('sha256');
async function walk(relative = '') {
  for (const name of (await readdir(join(root, relative))).sort()) {
    const child = join(relative, name), path = join(root, child), info = await lstat(path);
    hash.update(JSON.stringify([child, info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file', info.isDirectory() ? false : Boolean(info.mode & 0o111), info.isFile() ? info.size : 0]));
    if (info.isDirectory()) await walk(child);
    else if (info.isSymbolicLink()) hash.update(await readlink(path));
    else for await (const chunk of createReadStream(path)) hash.update(chunk);
  }
}
await walk();
console.log(hash.digest('hex'));
DIGEST
}
bundle_name="codex-runtime-$(runtime_digest "$vendor_dir")"
bundle_path="$harness_dir/$bundle_name"
staging=""
launcher=""
cleanup() {
  [[ -z "$staging" ]] || rm -rf -- "$staging"
  [[ -z "$launcher" ]] || rm -f -- "$launcher"
}
trap cleanup EXIT
if [[ -e "$bundle_path" ]]; then
  [[ -d "$bundle_path" && ! -L "$bundle_path" && "codex-runtime-$(runtime_digest "$bundle_path")" == "$bundle_name" ]] || {
    echo 'Existing Codex runtime does not match its content identity' >&2; exit 1
  }
else
  staging="$(mktemp -d "$harness_dir/.codex-runtime-${release_id}-XXXXXX")"
  cp -R "$vendor_dir/." "$staging/"
  chmod -R a+rX,go-w "$staging"
  "$staging/bin/codex" --version >/dev/null
  [[ "codex-runtime-$(runtime_digest "$staging")" == "$bundle_name" ]] || {
    echo 'Codex runtime changed during publication' >&2; exit 1
  }
  # Directory rename fails if another publisher has already installed a full
  # bundle. Never nest a staged copy into an existing runtime directory.
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staging" "$bundle_path"
  staging=""
fi
"$bundle_path/bin/codex" --version >/dev/null
launcher="$(mktemp "$harness_dir/.codex-launcher-XXXXXX")"
cat > "$launcher" <<'LAUNCHER'
#!/bin/sh
set -eu
runtime_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LAUNCHER
printf 'runtime_dir="$runtime_dir/%s"\n' "$bundle_name" >> "$launcher"
cat >> "$launcher" <<'LAUNCHER'
export PATH="$runtime_dir/codex-path:${PATH:-}"
exec "$runtime_dir/bin/codex" "$@"
LAUNCHER
chmod 0755 "$launcher"
mv -f "$launcher" "$harness_dir/codex"
launcher=""
