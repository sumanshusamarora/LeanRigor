#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK_DIR=${LEANRIGOR_SMOKE_DIR:-$(mktemp -d)}
TARBALL=${LEANRIGOR_TARBALL:-}
TIMEOUT_SECONDS=${LEANRIGOR_SMOKE_TIMEOUT_SECONDS:-900}

log() {
  printf '%s\n' "$*"
}

run_json_field() {
  node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d); console.log($1);})"
}

if ! command -v claude >/dev/null 2>&1; then
  log "Claude CLI is not on PATH."
  exit 1
fi

log "Smoke repo: $WORK_DIR"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"
git init -q
git config user.email smoke@example.com
git config user.name "LeanRigor Smoke"

cat > package.json <<'JSON'
{
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON
mkdir -p src test
cat > src/math.js <<'JS'
export function subtract(a, b) {
  return a - b;
}
JS
cat > test/math.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
import { subtract } from "../src/math.js";

test("subtract", () => {
  assert.equal(subtract(3, 1), 2);
});
JS
git add package.json src/math.js test/math.test.js
git commit -q -m baseline
BASE_HEAD=$(git rev-parse HEAD)

if [ -n "$TARBALL" ]; then
  npm install "$TARBALL" >/dev/null
else
  npm install "$ROOT_DIR" >/dev/null
fi

npx leanrigor init --adapter claude >/dev/null
HOOK=.claude/leanrigor/protect-git.sh
test -x "$HOOK"
npx leanrigor doctor --adapter claude | tee doctor.out
grep -q "protect-git.sh: current and executable" doctor.out

printf '%s\n' '{"command":"git commit -m blocked"}' | sh "$HOOK" >/tmp/leanrigor-hook.out 2>/tmp/leanrigor-hook.err && {
  log "Hook did not block git commit."
  exit 1
}
grep -qi "blocked" /tmp/leanrigor-hook.err
printf '%s\n' '{"command":"npm test"}' | sh "$HOOK" >/tmp/leanrigor-hook-allowed.out 2>/tmp/leanrigor-hook-allowed.err
test ! -s /tmp/leanrigor-hook-allowed.err

claude --version

npx leanrigor flow start --provider deterministic "Add an exported add(a, b) function to src/math.js and add one test. Preserve subtract()." >/dev/null
WF=$(basename .leanrigor/workflows/*.json .json)
npx leanrigor flow approve-approach "$WF" >/dev/null
node <<NODE
const fs = require("fs");
const p = ".leanrigor/workflows/$WF.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
const phase = s.plan.phases[0];
s.plan.phases = [{
  ...phase,
  id: "phase-1",
  objective: "Implement the math addition smoke change.",
  rationale: "The smoke task is intentionally small and cohesive, so implementation and test evidence belong in one isolated phase workspace.",
  dependencies: [],
  dependsOn: [],
  expectedReadAreas: ["src/math.js", "test/math.test.js", "package.json"],
  expectedWriteAreas: ["src/math.js", "test/math.test.js"],
  expectedFilesOrAreas: ["src/math.js", "test/math.test.js"],
  acceptanceCriteria: [
    "src/math.js exports add(a, b) and preserves subtract(a, b).",
    "test/math.test.js includes one passing add() test and keeps the subtract() test."
  ],
  validationCommands: ["npm test"],
  ownershipUncertain: false,
  status: "planned",
  filesChanged: [],
  commandsRun: [],
  validationResults: [],
  scopeDeviations: [],
  repairAttempts: []
}];
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\\n");
NODE
npx leanrigor flow approve-plan "$WF" >/dev/null

BEFORE_SOURCE_STATUS=$(git status --porcelain=v1 -- src test)
test -z "$BEFORE_SOURCE_STATUS"

START=$(date +%s)
ACTION=dispatch
while :; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -gt "$TIMEOUT_SECONDS" ]; then
    log "Timed out waiting for final integrated review."
    npx leanrigor flow execution-status "$WF" --provider claude-cli --json
    exit 1
  fi

  if [ "$ACTION" = "dispatch" ]; then
    OUT=$(npx leanrigor flow execute-next "$WF" --provider claude-cli --json)
  else
    OUT=$(npx leanrigor flow execution-poll "$WF" --provider claude-cli --json)
  fi
  printf '%s\n' "$OUT"
  ACTION=$(printf '%s\n' "$OUT" | run_json_field "j.nextAction")
  STATE=$(printf '%s\n' "$OUT" | run_json_field "j.state")
  [ "$STATE" = "reviewing" ] && [ "$ACTION" = "final_review" ] && break
  BLOCKED=$(printf '%s\n' "$OUT" | run_json_field "j.blocked.length")
  if [ "$BLOCKED" != "0" ] || [ "$ACTION" = "repair" ] || [ "$ACTION" = "review" ] || [ "$ACTION" = "resolve_conflict" ] || [ "$ACTION" = "replan" ] || [ "$ACTION" = "await_user" ]; then
    log "Smoke stopped before final review at action=$ACTION state=$STATE."
    WF="$WF" node <<'NODE'
const fs = require("fs");
const cp = require("child_process");
const state = JSON.parse(fs.readFileSync(`.leanrigor/workflows/${process.env.WF}.json`, "utf8"));
const records = Object.values(state.execution.records);
const record = records[records.length - 1];
const meta = record?.providerMetadata ?? {};
let status;
try { status = meta.statusPath ? JSON.parse(fs.readFileSync(meta.statusPath, "utf8")) : undefined; } catch {}
console.log(JSON.stringify({
  workflowId: state.id,
  executionId: record?.providerExecutionId,
  phaseWorkspacePath: record?.workspacePath,
  integrationWorkspacePath: state.git?.integration?.path,
  executionArtifactDirectory: meta.artifactDir ?? (meta.statusPath ? require("path").dirname(meta.statusPath) : undefined),
  providerExitStatus: status ? { status: status.status, exitCode: status.exitCode, signal: status.signal } : undefined,
  parserFailureReason: record?.resultSummary,
  diagnostics: record?.diagnostics ? {
    stdoutExcerpt: record.diagnostics.stdoutExcerpt,
    stderrExcerpt: record.diagnostics.stderrExcerpt,
    nextStep: record.diagnostics.nextStep
  } : undefined,
  nextValidRecoveryCommand: `npx leanrigor flow execution-poll ${state.id} --provider claude-cli --root ${JSON.stringify(process.cwd())}`,
  originalStatus: cp.execFileSync("git", ["status", "--porcelain=v1", "--", "src", "test"], { encoding: "utf8" }).trim()
}, null, 2));
NODE
    exit 1
  fi
  sleep 5
done

node <<'NODE'
const fs = require("fs");
const workflow = fs.readdirSync(".leanrigor/workflows").find((f) => f.endsWith(".json"));
const state = JSON.parse(fs.readFileSync(`.leanrigor/workflows/${workflow}`, "utf8"));
const records = Object.values(state.execution.records);
if (records.length === 0) throw new Error("No execution records persisted.");
for (const record of records) {
  if (record.providerId !== "claude-cli") throw new Error(`Unexpected provider ${record.providerId}`);
  if (!record.providerExecutionId) throw new Error("Missing provider execution ID.");
  if (!record.workspacePath.includes("/phases/")) throw new Error(`Unexpected workspace path ${record.workspacePath}`);
  if (record.status !== "result_recorded") throw new Error(`Result not recorded for ${record.phaseId}: ${record.status}`);
}
if (state.state !== "reviewing") throw new Error(`Expected reviewing, got ${state.state}`);
if (state.git.integration.status !== "ready_for_final_review") throw new Error("Integration is not ready for final review.");
if (state.git.integrationValidation?.status !== "passed") throw new Error("Combined validation did not pass.");
console.log(JSON.stringify({
  workflow: state.id,
  state: state.state,
  records: records.map((record) => ({ phaseId: record.phaseId, providerExecutionId: record.providerExecutionId, workspacePath: record.workspacePath })),
  integration: state.git.integration.path,
  validation: state.git.integrationValidation.status
}, null, 2));
NODE

npx leanrigor flow record-review "$WF" --status passed --summary "Smoke final integrated review passed." >/dev/null
npx leanrigor flow commit-plan "$WF" >/tmp/leanrigor-smoke-commit-plan.out
grep -q "Proposal only" /tmp/leanrigor-smoke-commit-plan.out

AFTER_HEAD=$(git rev-parse HEAD)
AFTER_SOURCE_STATUS=$(git status --porcelain=v1 -- src test)
test "$AFTER_HEAD" = "$BASE_HEAD"
test -z "$AFTER_SOURCE_STATUS"

log "Claude CLI execution smoke passed for $WF"
