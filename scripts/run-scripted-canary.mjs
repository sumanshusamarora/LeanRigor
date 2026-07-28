import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? process.cwd());
const cli = path.join(root, "dist", "cli", "index.js");
const reportFile = path.resolve(required(args.report, "--report"));
const existingReport = args["workflow-id"]
  ? JSON.parse(readFileSync(reportFile, "utf8"))
  : undefined;
const request = args.request ?? existingReport?.request ?? required(args.request, "--request");
const scriptFile = args.script ? path.resolve(args.script) : undefined;
const transitions = [];
const decisions = [];

const workflowId = args["workflow-id"]
  ?? run(["flow", "start", request, "--provider", "deterministic", "--root", root]).id;

if (args["workflow-id"]) {
  const state = run(["flow", "status", workflowId, "--root", root, "--json"]);
  writeReport(state);
  process.stdout.write(`${JSON.stringify({ workflowId, reportFile, status: "refreshed" })}\n`);
  process.exit(0);
}

if (!scriptFile) throw new Error("--script is required when starting a canary.");

for (let step = 0; step < 80; step += 1) {
  const state = run(["flow", "status", workflowId, "--root", root, "--json"]);
  transitions.push({
    revision: state.revision,
    lifecycle: state.state,
    status: state.status,
    decisionType: state.decision?.type
  });
  if (state.state === "completed") {
    writeReport(state);
    process.stdout.write(`${JSON.stringify({ workflowId, reportFile, status: "completed" })}\n`);
    process.exit(0);
  }
  if (state.state === "cancelled" || state.state === "blocked") {
    throw new Error(`Canary stopped in ${state.state}: ${state.status?.summary ?? "no status"}`);
  }

  if (state.decision) {
    decisions.push({
      revision: state.revision,
      id: state.decision.id,
      type: state.decision.type,
      phaseId: state.decision.phaseId,
      question: state.decision.question,
      selected: approvalAction(state.decision.type)
    });
    answerDecision(state);
    continue;
  }

  const operation = state.nextOperation?.type;
  if (operation === "execute-next") {
    run(["flow", "execute-next", workflowId, "--provider", "scripted", "--script-file", scriptFile, "--root", root, "--json"]);
    continue;
  }
  if (operation === "execution-poll") {
    run(["flow", "execution-poll", workflowId, "--provider", "scripted", "--script-file", scriptFile, "--root", root, "--json"]);
    continue;
  }
  if (operation === "validate-integration") {
    run(["flow", "validate-integration", workflowId, "--expected-revision", String(state.revision), "--root", root, "--json"]);
    continue;
  }
  throw new Error(`No supported public transition from ${state.state} revision ${state.revision}; next operation is ${operation ?? "absent"}.`);
}

throw new Error("Canary exceeded 80 public transitions.");

function answerDecision(state) {
  const decision = state.decision;
  const common = ["--decision-id", decision.id, "--expected-revision", String(state.revision), "--root", root];
  switch (decision.type) {
    case "approach-approval":
      run(["flow", "approve-approach", workflowId, "--provider", "deterministic", ...common]);
      return;
    case "workflow-plan-approval":
      run(["flow", "approve-plan", workflowId, "--approval-policy", "phase-by-phase", ...common]);
      return;
    case "phase-brief-approval":
      run([
        "flow", "approve-phase", workflowId, decision.phaseId,
        "--brief-revision", String(decision.briefRevision),
        "--workflow-revision", String(decision.workflowRevision),
        ...common
      ]);
      return;
    case "workspace-bootstrap-approval": {
      const command = decision.options.find((option) => option.intent === "approve-bootstrap")?.command ?? "";
      const identity = command.match(/--workspace-identity "([^"]+)"/)?.[1];
      const bootstrap = command.match(/--command "([^"]+)"/)?.[1];
      if (!identity || !bootstrap) throw new Error("Bootstrap decision omitted its exact workspace identity or command.");
      run([
        "flow", "approve-bootstrap", workflowId, decision.phaseId,
        "--brief-revision", String(decision.briefRevision),
        "--preparation-revision", String(decision.preparationRevision),
        "--workspace-identity", identity,
        "--command", bootstrap,
        ...common
      ]);
      return;
    }
    case "final-review":
      run([
        "flow", "record-review", workflowId,
        "--status", "passed",
        "--summary", "Deterministic scripted-provider canary review passed.",
        ...common
      ]);
      return;
    case "final-completion":
      run(["flow", "complete", workflowId, ...common]);
      return;
    default:
      throw new Error(`Canary requires a non-automatic decision: ${decision.type}: ${decision.question}`);
  }
}

function writeReport(state) {
  const briefs = Object.values(state.phaseBriefs ?? {});
  const phaseResults = (state.phaseProgress ?? []).map((phase) =>
    run(["flow", "phase-result", workflowId, phase.id, "--root", root, "--json"]));
  const capturedDecisions = decisions.length > 0 ? decisions : existingReport?.userDecisionsRequested ?? [];
  const capturedTransitions = transitions.length > 0 ? transitions : existingReport?.transitions ?? [];
  const report = {
    schemaVersion: 1,
    workflowId,
    request,
    mode: state.mode,
    repositoryRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    artifactRevisions: briefs.map((brief) => ({
      phaseId: brief.phaseId,
      workflowRevision: brief.workflowRevision,
      briefRevision: brief.briefRevision,
      deterministicallySynthesized: Boolean(brief.deterministicallySynthesized)
    })),
    qualityResults: briefs.map((brief) => brief.quality),
    recoveryAttempts: briefs.flatMap((brief) => brief.recoveryAttempts ?? []),
    phaseGraph: (state.phaseProgress ?? []).map((phase) => ({
      phaseId: phase.id,
      objective: phase.objective,
      dependencies: phase.dependencies ?? phase.dependsOn ?? [],
      expectedFilesOrAreas: phase.expectedFilesOrAreas ?? [],
      acceptanceCriteria: phase.acceptanceCriteria ?? [],
      status: phase.status
    })),
    approvals: state.approval?.history ?? capturedDecisions,
    providerExecutions: state.execution ?? [],
    phaseResults,
    completionGateResults: phaseResults.map((result) => ({
      phaseId: result.phaseId,
      status: result.lifecycle?.completionGate,
      acceptance: result.lifecycle?.phaseAcceptance,
      evidence: result.evidence
    })),
    validationEvidence: state.validation ?? [],
    integrationResults: phaseResults.map((result) => ({
      phaseId: result.phaseId,
      status: result.lifecycle?.integration,
      integratedValidation: result.lifecycle?.integratedValidation
    })),
    finalReview: state.review,
    finalStatus: state.state,
    finalSummary: state.status,
    firstBlocker: capturedTransitions.find((transition) => transition.lifecycle === "blocked") ?? null,
    userDecisionsRequested: capturedDecisions,
    transitions: capturedTransitions
  };
  mkdirSync(path.dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}

function approvalAction(type) {
  return ({
    "approach-approval": "approve-approach",
    "workflow-plan-approval": "approve-plan",
    "phase-brief-approval": "approve-phase",
    "workspace-bootstrap-approval": "approve-bootstrap",
    "final-review": "record-review:passed",
    "final-completion": "complete"
  })[type] ?? "none";
}

function run(commandArgs) {
  const output = execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240_000
  });
  return JSON.parse(output);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    if (!key || values[index + 1] === undefined) throw new Error(`Invalid argument near ${values[index] ?? "<end>"}.`);
    parsed[key] = values[index + 1];
  }
  return parsed;
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required.`);
  return value;
}
