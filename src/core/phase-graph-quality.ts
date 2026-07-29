import type { PlanDiagnostic } from "./planning-runner.js";
import type { ExecutionPlan, WorkflowPhase } from "./types.js";

export interface PhaseGraphRepairResult {
  plan: ExecutionPlan;
  changed: boolean;
  repairs: string[];
}

export function validatePhaseGraphQuality(plan: ExecutionPlan): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const byId = new Map(plan.phases.map((phase) => [phase.id, phase]));

  for (const [index, phase] of plan.phases.entries()) {
    if (phase.validationCommands.length === 0) {
      diagnostics.push(diagnostic(index, phase.id, "closure.validation_missing", `Phase ${phase.id} cannot establish an independently valid repository state without a validation command or check.`));
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
