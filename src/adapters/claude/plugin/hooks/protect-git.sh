#!/usr/bin/env bash
# generated_by: leanrigor | asset_version: 1
#
# LeanRigor git protection hook
#
# Blocks automatic git commit and git push to enforce the LeanRigor commit
# workflow. Fails open (exit 0) on any error or unrecognised input to avoid
# blocking legitimate tool use.
#
# This script is invoked by Claude Code as a PreToolUse hook when the Bash
# tool is about to execute. Tool input is provided on stdin as a JSON object
# with at least a "command" field.
#
# Verified behaviour: not tested without Claude Code installed.
# Hook format follows Claude Code settings.json PreToolUse conventions.

set -uo pipefail
INPUT=$(cat 2>/dev/null) || INPUT=""

# Fail open if stdin is empty or does not look like tool-input JSON
if [ -z "$INPUT" ] || ! echo "$INPUT" | grep -qE '"command"[[:space:]]*:'; then
  exit 0
fi

# Block git push
if echo "$INPUT" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]*git[[:space:]]+push'; then
  echo "LeanRigor: 'git push' is blocked by the safety hook." >&2
  echo "Use the /leanrigor-commit workflow to propose and confirm commits first." >&2
  exit 1
fi

# Block git commit
if echo "$INPUT" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]*git[[:space:]]+commit'; then
  echo "LeanRigor: 'git commit' is blocked by the safety hook." >&2
  echo "Use /leanrigor-commit to prepare a commit proposal and confirm it explicitly." >&2
  exit 1
fi

# Block destructive reset
if echo "$INPUT" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]*git[[:space:]]+reset[[:space:]]+--hard'; then
  echo "LeanRigor: 'git reset --hard' is blocked by the safety hook." >&2
  echo "This destructive operation requires explicit manual confirmation." >&2
  exit 1
fi

exit 0
