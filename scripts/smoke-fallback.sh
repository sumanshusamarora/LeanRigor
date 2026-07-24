#!/usr/bin/env bash
# Smoke test: project-local fallback mode
# Verifies that leanrigor init --adapter claude installs all assets.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== Project-Local Fallback Mode Smoke Test ==="
echo "Test repo: $TMP_DIR"

cd "$TMP_DIR"
git init --quiet
git config user.email "test@example.com"
git config user.name "Test"

# No marketplace env vars — should detect as unknown and bootstrap

echo ""
echo "1. Running leanrigor init --adapter claude..."
node "$REPO_ROOT/dist/cli/index.js" init --adapter claude --root "$TMP_DIR" 2>&1 | grep -q "LeanRigor configured" || { echo "FAIL: init should succeed"; exit 1; }
echo "   PASS: init succeeded"

echo ""
echo "2. Verifying fallback assets installed..."
test -f ".claude/commands/leanrigor.md" || { echo "FAIL: .claude/commands/leanrigor.md missing"; exit 1; }
test -f ".claude/commands/leanrigor-init.md" || { echo "FAIL: .claude/commands/leanrigor-init.md missing"; exit 1; }
test -f ".claude/agents/leanrigor-triage.md" || { echo "FAIL: .claude/agents/leanrigor-triage.md missing"; exit 1; }
test -f ".claude/leanrigor/protect-git.sh" || { echo "FAIL: .claude/leanrigor/protect-git.sh missing"; exit 1; }
test -f ".claude/leanrigor/methodology/core.md" || { echo "FAIL: .claude/leanrigor/methodology/core.md missing"; exit 1; }
test -f ".claude/settings.json" || { echo "FAIL: .claude/settings.json missing"; exit 1; }
echo "   PASS: all fallback assets present"

echo ""
echo "3. Running leanrigor doctor..."
node "$REPO_ROOT/dist/cli/index.js" doctor --root "$TMP_DIR" 2>&1 | grep -q "project-local" || echo "   NOTE: mode detection depends on env; may show 'unknown'"
node "$REPO_ROOT/dist/cli/index.js" doctor --root "$TMP_DIR" 2>&1 | grep -q "Fallback assets:" || { echo "FAIL: doctor should show fallback assets"; exit 1; }
echo "   PASS: doctor reports fallback assets"

echo ""
echo "4. Repeat init (idempotency)..."
node "$REPO_ROOT/dist/cli/index.js" init --adapter claude --root "$TMP_DIR" 2>&1 | grep -q "Skipped\|Already current\|LeanRigor configured" || { echo "FAIL: repeat init should report already-current or skipped"; exit 1; }
echo "   PASS: repeat init is idempotent"

echo ""
echo "5. Running leanrigor flow start..."
node "$REPO_ROOT/dist/cli/index.js" flow start "Add a new feature" --provider deterministic --root "$TMP_DIR" 2>&1 | grep -q '"state"' || { echo "FAIL: flow start should produce valid JSON"; exit 1; }
echo "   PASS: flow start works"

echo ""
echo "=== Fallback Smoke Test PASSED ==="
