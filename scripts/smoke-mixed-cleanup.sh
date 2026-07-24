#!/usr/bin/env bash
# Smoke test: mixed-mode detection and cleanup
# Verifies that stale project-local assets are detected and cleanly removed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== Mixed-Mode Cleanup Smoke Test ==="
echo "Test repo: $TMP_DIR"

cd "$TMP_DIR"
git init --quiet
git config user.email "test@example.com"
git config user.name "Test"

# 1. Seed project-local fallback assets (simulating old installation)
echo ""
echo "1. Seeding project-local fallback assets..."
# Set up .leanrigor/ state
node "$REPO_ROOT/dist/cli/index.js" init --adapter claude --root "$TMP_DIR" 2>&1 | grep -q "LeanRigor configured" || { echo "FAIL: Could not seed assets"; exit 1; }
echo "   Seeded project-local assets"

# 2. Verify doctor detects mixed mode
echo ""
echo "2. Running doctor with marketplace env..."
export CLAUDE_PLUGIN_ROOT="$REPO_ROOT"
node "$REPO_ROOT/dist/cli/index.js" doctor --root "$TMP_DIR" 2>&1 | grep -q "shadowing" || { echo "FAIL: doctor should detect shadowing risk"; exit 1; }
echo "   PASS: shadowing risk detected"

# 3. Dry-run cleanup
echo ""
echo "3. Running cleanup dry-run (default)..."
node "$REPO_ROOT/dist/cli/index.js" cleanup --adapter claude --project-local-only --root "$TMP_DIR" 2>&1 | grep -q "dry-run" || { echo "FAIL: cleanup dry-run should indicate dry-run"; exit 1; }
node "$REPO_ROOT/dist/cli/index.js" cleanup --adapter claude --project-local-only --root "$TMP_DIR" 2>&1 | grep -q "leanrigor" || { echo "FAIL: cleanup dry-run should list files"; exit 1; }
echo "   PASS: dry-run lists planned changes"

# 4. Verify assets still exist after dry-run
echo ""
echo "4. Verifying assets untouched after dry-run..."
test -f ".claude/commands/leanrigor.md" || { echo "FAIL: assets should still exist after dry-run"; exit 1; }
echo "   PASS: assets preserved after dry-run"

# 5. Execute cleanup
echo ""
echo "5. Executing cleanup..."
node "$REPO_ROOT/dist/cli/index.js" cleanup --adapter claude --project-local-only --no-dry-run --root "$TMP_DIR" 2>&1 | grep -q "Removed\|removed" || { echo "FAIL: cleanup should indicate removal"; exit 1; }
echo "   PASS: cleanup executed"

# 6. Verify fallback assets removed
echo ""
echo "6. Verifying fallback assets removed..."
if test -f ".claude/commands/leanrigor.md"; then
  echo "FAIL: .claude/commands/leanrigor.md should have been removed"
  exit 1
fi
echo "   PASS: fallback assets removed"

# 7. Verify .leanrigor/ preserved (cleanup was project-local-only)
echo ""
echo "7. Verifying .leanrigor/ preserved..."
test -d ".leanrigor" || { echo "FAIL: .leanrigor/ should be preserved with --project-local-only"; exit 1; }
echo "   PASS: .leanrigor/ preserved"

# 8. Verify clean marketplace mode after cleanup
echo ""
echo "8. Verifying clean marketplace mode after cleanup..."
node "$REPO_ROOT/dist/cli/index.js" doctor --root "$TMP_DIR" 2>&1 | grep -q "marketplace" || { echo "FAIL: should detect marketplace mode"; exit 1; }
node "$REPO_ROOT/dist/cli/index.js" doctor --root "$TMP_DIR" 2>&1 | grep -q "not applicable" || { echo "FAIL: fallback assets should be not applicable"; exit 1; }
echo "   PASS: clean marketplace mode"

echo ""
echo "=== Mixed-Mode Cleanup Smoke Test PASSED ==="
