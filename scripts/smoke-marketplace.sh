#!/usr/bin/env bash
# Smoke test: marketplace plugin mode
# Verifies that marketplace mode creates .leanrigor/ but NOT .claude/ assets.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== Marketplace Mode Smoke Test ==="
echo "Test repo: $TMP_DIR"

cd "$TMP_DIR"
git init --quiet
git config user.email "test@example.com"
git config user.name "Test"

# Run with marketplace env vars set
export CLAUDE_PLUGIN_ROOT="$REPO_ROOT"
export LEANRIGOR_CLAUDE_PLUGIN_ROOT="$REPO_ROOT"

echo ""
echo "1. Running leanrigor init-report..."
node "$REPO_ROOT/dist/cli/index.js" init-report --root "$TMP_DIR" 2>&1 | grep -q "marketplace" || { echo "FAIL: init-report should show marketplace mode"; exit 1; }
echo "   PASS: marketplace mode detected"

echo ""
echo "2. Checking .leanrigor/ was created..."
test -d ".leanrigor" || { echo "FAIL: .leanrigor/ not created"; exit 1; }
test -f ".leanrigor/config.json" || { echo "FAIL: .leanrigor/config.json not created"; exit 1; }
test -f ".leanrigor/.gitignore" || { echo "FAIL: .leanrigor/.gitignore not created"; exit 1; }
echo "   PASS: .leanrigor/ created correctly"

echo ""
echo "3. Verifying NO .claude/ was created..."
if test -d ".claude"; then
  echo "FAIL: .claude/ should not be created in marketplace mode"
  ls -la .claude/
  exit 1
fi
echo "   PASS: no .claude/ directory"

echo ""
echo "4. Running leanrigor doctor..."
node "$REPO_ROOT/dist/cli/index.js" doctor --root "$TMP_DIR" 2>&1 | grep -q "not applicable" || { echo "FAIL: doctor should report fallback assets as not applicable"; exit 1; }
echo "   PASS: doctor reports fallback assets as not applicable"

echo ""
echo "5. Running leanrigor doctor (mode check)..."
node "$REPO_ROOT/dist/cli/index.js" doctor --root "$TMP_DIR" 2>&1 | grep -q "Installation mode: marketplace" || { echo "FAIL: doctor should show marketplace mode"; exit 1; }
echo "   PASS: doctor reports installation mode"

echo ""
echo "6. Running leanrigor flow start..."
node "$REPO_ROOT/dist/cli/index.js" flow start "Fix a typo in README" --provider deterministic --root "$TMP_DIR" 2>&1 | grep -q '"state"' || { echo "FAIL: flow start should produce valid JSON"; exit 1; }
echo "   PASS: flow start works"

echo ""
echo "=== Marketplace Smoke Test PASSED ==="
