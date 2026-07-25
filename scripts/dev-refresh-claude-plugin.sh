#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=0
RESET_STATE=0
FORCE=0

usage() {
  cat <<USAGE
Usage: ./scripts/dev-refresh-claude-plugin.sh [--dry-run] [--reset-state] [--force]

Options:
  --dry-run      Show planned actions without changing anything
  --reset-state  Also remove repository runtime state (.leanrigor/)
  --force        Reinstall even when installed version matches remote main version
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --reset-state) RESET_STATE=1 ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

step() {
  printf "\n==> %s\n" "$1"
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf "[dry-run] %s\n" "$*"
    return 0
  fi
  "$@"
}

run_allow_fail() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf "[dry-run] %s\n" "$*"
    return 0
  fi
  if ! "$@"; then
    printf "WARN: command failed (continuing): %s\n" "$*" >&2
  fi
}

json_version() {
  node "$REPO_ROOT/scripts/json-get.mjs" "$1" "$2"
}

collect_cache_paths() {
  local -a candidates=(
    "$HOME/.claude/plugins"
    "$HOME/.claude/cache/plugins"
    "$HOME/.cache/claude/plugins"
    "$HOME/.cache/Claude/plugins"
    "$HOME/Library/Caches/Claude/plugins"
  )

  if [ -n "${APPDATA:-}" ]; then
    candidates+=("$APPDATA/Claude/plugins")
  fi

  for base in "${candidates[@]}"; do
    [ -d "$base" ] || continue
    find "$base" -maxdepth 6 -type f -name "plugin.json" -print 2>/dev/null | while IFS= read -r plugin_manifest; do
      if grep -Eq '"name"[[:space:]]*:[[:space:]]*"leanrigor"' "$plugin_manifest"; then
        dirname "$plugin_manifest"
      fi
    done
  done
}

collect_installed_versions() {
  while IFS= read -r path; do
    if [ -f "$path" ]; then
      path="$(dirname "$path")"
    fi
    [ -f "$path/plugin.json" ] || continue
    local version
    version=$(json_version "$path/plugin.json" version 2>/dev/null || true)
    [ -n "$version" ] || continue
    printf "%s|%s\n" "$path" "$version"
  done < <(collect_cache_paths | sort -u)
}

step "Developer refresh for LeanRigor Claude marketplace plugin"
printf "Repository root: %s\n" "$REPO_ROOT"

step "Detecting LeanRigor runtime and cache locations"
mapfile -t cache_paths < <(collect_cache_paths | sort -u)
if [ "${#cache_paths[@]}" -eq 0 ]; then
  echo "No LeanRigor cache entries found in known Claude cache paths."
else
  echo "LeanRigor-related cache entries:"
  printf '  %s\n' "${cache_paths[@]}"
fi

echo "Repo runtime state: $REPO_ROOT/.leanrigor"
echo "Repo fallback assets: $REPO_ROOT/.claude"
echo "User config: $HOME/.config/leanrigor"

step "Resolving local and remote versions"
LOCAL_VERSION=$(json_version "$REPO_ROOT/package.json" version)
REMOTE_VERSION="$LOCAL_VERSION"
if git -C "$REPO_ROOT" fetch origin main:refs/remotes/origin/main >/dev/null 2>&1; then
  REMOTE_VERSION=$(git -C "$REPO_ROOT" show origin/main:package.json | json_version - version)
else
  echo "WARN: could not fetch origin/main; using local package version for refresh checks."
fi

echo "Local package version:  $LOCAL_VERSION"
echo "Remote main version:    $REMOTE_VERSION"

mapfile -t installed_versions < <(collect_installed_versions)
if [ "${#installed_versions[@]}" -gt 0 ]; then
  echo "Installed cache versions:"
  printf '  %s\n' "${installed_versions[@]}"
fi

if [ "$FORCE" -ne 1 ] && [ "${#installed_versions[@]}" -gt 0 ]; then
  for entry in "${installed_versions[@]}"; do
    installed_version="${entry##*|}"
    if [ "$installed_version" = "$REMOTE_VERSION" ]; then
      echo "Refusing reinstall: installed version matches remote main ($REMOTE_VERSION). Use --force to proceed."
      exit 1
    fi
  done
fi

step "Uninstall LeanRigor plugin from known Claude scopes"
if command -v claude >/dev/null 2>&1; then
  for scope in user project local; do
    run_allow_fail claude plugin uninstall leanrigor@leanrigor -s "$scope" --keep-data
    run_allow_fail claude plugin uninstall leanrigor -s "$scope" --keep-data
  done
else
  echo "WARN: claude CLI not found; skipping plugin uninstall/reinstall commands."
fi

step "Remove only LeanRigor plugin cache entries"
if [ "${#cache_paths[@]}" -eq 0 ]; then
  echo "No LeanRigor cache entries to remove."
else
  for entry in "${cache_paths[@]}"; do
    run rm -rf "$entry"
  done
fi

step "Remove LeanRigor-owned project-local fallback assets and hook entries"
LEANRIGOR_CLI=(node "$REPO_ROOT/dist/cli/index.js")
if [ ! -f "$REPO_ROOT/dist/cli/index.js" ]; then
  echo "WARN: dist/cli/index.js not found; run npm run build first for cleanup/doctor verification."
  LEANRIGOR_CLI=()
fi

if [ "${#LEANRIGOR_CLI[@]}" -gt 0 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    "${LEANRIGOR_CLI[@]}" cleanup --adapter claude --project-local-only --root "$REPO_ROOT" || true
  else
    "${LEANRIGOR_CLI[@]}" cleanup --adapter claude --project-local-only --root "$REPO_ROOT" --no-dry-run || true
  fi
fi

if [ "$RESET_STATE" -eq 1 ]; then
  step "Removing repository runtime state (.leanrigor/)"
  if [ "${#LEANRIGOR_CLI[@]}" -gt 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      "${LEANRIGOR_CLI[@]}" cleanup --adapter claude --runtime-state --root "$REPO_ROOT" || true
    else
      "${LEANRIGOR_CLI[@]}" cleanup --adapter claude --runtime-state --root "$REPO_ROOT" --no-dry-run || true
    fi
  fi
else
  echo "Preserving repository runtime state (.leanrigor/)."
fi

step "Update marketplace and reinstall plugin"
if command -v claude >/dev/null 2>&1; then
  run claude plugin marketplace add sumanshusamarora/LeanRigor
  run claude plugin install leanrigor@leanrigor -s user
else
  echo "ERROR: claude CLI not found; cannot reinstall plugin automatically." >&2
  exit 1
fi

step "Verification"
if command -v claude >/dev/null 2>&1; then
  run claude plugin list
fi

if [ "${#LEANRIGOR_CLI[@]}" -gt 0 ]; then
  run node "$REPO_ROOT/dist/cli/index.js" doctor --adapter claude --root "$REPO_ROOT"
else
  echo "ERROR: dist/cli/index.js not found; run npm run build then rerun this refresh script." >&2
  exit 1
fi

step "Next action"
echo "In Claude Code, run /leanrigor:init after reload/restart to confirm active runtime, version, and mode."
