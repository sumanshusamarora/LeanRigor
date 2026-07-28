import type { PlanDiagnostic } from "./planning-runner.js";
import type { ExecutionPlan, WorkflowPhase } from "./types.js";

export interface PhaseGraphRepairResult {
  plan: ExecutionPlan;
  changed: boolean;
  repairs: string[];
}

export function validatePhaseGraphQuality(plan: ExecutionPlan): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const positions = new Map(plan.phases.map((phase, index) => [phase.id, index]));
  const byId = new Map(plan.phases.map((phase) => [phase.id, phase]));

  for (const [index, phase] of plan.phases.entries()) {
    if (phase.validationCommands.length === 0) {
      diagnostics.push(diagnostic(index, phase.id, "closure.validation_missing", `Phase ${phase.id} cannot establish an independently valid repository state without a validation command or check.`));
    }

    for (const token of declaredReferences(phase.acceptanceCriteria)) {
      const producers = plan.phases.filter((candidate) =>
        candidate.id !== phase.id && declaredTokens(candidate).has(token));
      const futureProducer = producers.find((candidate) => (positions.get(candidate.id) ?? -1) > index);
      if (futureProducer) {
        diagnostics.push(diagnostic(
          index,
          phase.id,
          "closure.future_dependency",
          `Phase ${phase.id} acceptance references ${token}, which is introduced by later phase ${futureProducer.id}. Move the producer earlier or remove that outcome from the current phase boundary.`
        ));
        continue;
      }
      const earlierProducer = producers.find((candidate) => !transitivelyDependsOn(phase, candidate.id, byId));
      if (earlierProducer) {
        diagnostics.push(diagnostic(
          index,
          phase.id,
          "dependency.unlinked_producer",
          `Phase ${phase.id} acceptance references ${token} from earlier phase ${earlierProducer.id}, but the dependency is not declared.`
        ));
      }
    }
  }

  for (let right = 1; right < plan.phases.length; right += 1) {
    const later = plan.phases[right];
    for (let left = 0; left < right; left += 1) {
      const earlier = plan.phases[left];
      if (transitivelyDependsOn(later, earlier.id, byId)) continue;
      const overlap = writeBoundaryOverlap(earlier, later);
      if (!overlap) continue;
      diagnostics.push(diagnostic(
        right,
        later.id,
        "dependency.write_boundary_overlap",
        `Phases ${earlier.id} and ${later.id} both write ${overlap} without an ordering dependency.`
      ));
    }
  }

  return uniqueDiagnostics(diagnostics);
}

export function repairPhaseGraphDependencies(plan: ExecutionPlan): PhaseGraphRepairResult {
  const repaired = structuredClone(plan);
  const repairs: string[] = [];
  const byId = new Map(repaired.phases.map((phase) => [phase.id, phase]));

  for (let index = 0; index < repaired.phases.length; index += 1) {
    const phase = repaired.phases[index];
    const required = new Set(phase.dependencies);
    for (const token of declaredReferences(phase.acceptanceCriteria)) {
      const producer = [...repaired.phases.slice(0, index)].reverse()
        .find((candidate) => declaredTokens(candidate).has(token));
      if (producer && !transitivelyDependsOn(phase, producer.id, byId)) {
        required.add(producer.id);
        repairs.push(`Declared ${producer.id} as a dependency of ${phase.id} because its acceptance criteria reference ${token}.`);
      }
    }
    for (const earlier of repaired.phases.slice(0, index)) {
      const overlap = writeBoundaryOverlap(earlier, phase);
      if (overlap && !transitivelyDependsOn(phase, earlier.id, byId)) {
        required.add(earlier.id);
        repairs.push(`Ordered ${phase.id} after ${earlier.id} because both phases write ${overlap}.`);
      }
    }
    phase.dependencies = [...required];
    phase.dependsOn = [...required];
  }

  return { plan: repaired, changed: repairs.length > 0, repairs };
}

function declaredReferences(criteria: string[]): Set<string> {
  return codeTokens(criteria.join(" "));
}

function declaredTokens(phase: WorkflowPhase): Set<string> {
  return codeTokens([
    phase.objective,
    phase.rationale,
    ...phase.expectedFilesOrAreas,
    ...phase.expectedWriteAreas
  ].join(" "));
}

function codeTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/`([A-Za-z_$][\w$.-]{3,})`|\b([A-Z][A-Za-z0-9_$]{3,}|[a-z][a-z0-9]+_[a-z0-9_]{2,})\b/g)) {
    const candidate = match[1] ?? match[2];
    if (!match[1] && !candidate.includes("_") && !/[A-Z0-9]/.test(candidate.slice(1))) continue;
    const token = candidate.toLowerCase();
    if (!GENERIC_CODE_TOKENS.has(token)) tokens.add(token);
  }
  return tokens;
}

const GENERIC_CODE_TOKENS = new Set([
  "readme",
  "typescript",
  "javascript",
  "workflow",
  "validation",
  "repository",
  "standard",
  "rigorous"
]);

function transitivelyDependsOn(
  phase: WorkflowPhase,
  target: string,
  byId: Map<string, WorkflowPhase>,
  seen = new Set<string>()
): boolean {
  if (phase.dependencies.includes(target)) return true;
  if (seen.has(phase.id)) return false;
  seen.add(phase.id);
  return phase.dependencies.some((dependency) => {
    const parent = byId.get(dependency);
    return parent ? transitivelyDependsOn(parent, target, byId, seen) : false;
  });
}

function writeBoundaryOverlap(left: WorkflowPhase, right: WorkflowPhase): string | undefined {
  const leftAreas = implementationAreas(left);
  const rightAreas = implementationAreas(right);
  for (const leftArea of leftAreas) {
    for (const rightArea of rightAreas) {
      if (leftArea === rightArea || leftArea.startsWith(`${rightArea}/`) || rightArea.startsWith(`${leftArea}/`)) {
        return leftArea.length <= rightArea.length ? leftArea : rightArea;
      }
    }
  }
  return undefined;
}

function implementationAreas(phase: WorkflowPhase): string[] {
  return [...new Set((phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas)
    .map((area) => area.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\*\*.*$/, "").replace(/\/$/, ""))
    .filter((area) => area && !/^(tests?|__tests__|docs?|readme\.md)(\/|$)/i.test(area)))];
}

function diagnostic(index: number, phaseId: string, code: string, message: string): PlanDiagnostic {
  return {
    stage: "quality",
    path: ["phases", index],
    code,
    message,
    affectedPhase: phaseId
  };
}

function uniqueDiagnostics(diagnostics: PlanDiagnostic[]): PlanDiagnostic[] {
  return [...new Map(diagnostics.map((item) => [`${item.code}:${item.affectedPhase}:${item.message}`, item])).values()];
}
