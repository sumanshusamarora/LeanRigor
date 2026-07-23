#!/usr/bin/env bash
#
# LeanRigor git protection hook for marketplace/plugin installs.
# Blocks automatic git commit, git push, and git reset --hard. Fails open when
# input is missing or cannot be parsed.

set -uo pipefail
INPUT=$(cat 2>/dev/null || true)

if [ -z "$INPUT" ] || ! echo "$INPUT" | grep -qE '"command"[[:space:]]*:'; then
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  CMD=$(echo "$INPUT" | jq -r '.command // empty' 2>/dev/null) || CMD=""
else
  CMD=$(echo "$INPUT" | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/') || CMD=""
fi

if [ -z "$CMD" ]; then
  exit 0
fi

if echo "$CMD" | grep -qE '(^|[[:space:]])git[[:space:]]+push'; then
  echo "LeanRigor: git push is blocked by the plugin safety hook." >&2
  exit 1
fi

if echo "$CMD" | grep -qE '(^|[[:space:]])git[[:space:]]+commit'; then
  echo "LeanRigor: git commit is blocked by the plugin safety hook. Use /leanrigor:commit for a proposal first." >&2
  exit 1
fi

if echo "$CMD" | grep -qE '(^|[[:space:]])git[[:space:]]+reset[[:space:]]+--hard'; then
  echo "LeanRigor: git reset --hard is blocked by the plugin safety hook." >&2
  exit 1
fi

exit 0
