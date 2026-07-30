# Configuration reference

LeanRigor separates **personal provider preferences**, **committed repository policy**, and **private repository-local settings**. The runtime resolves them into one effective configuration and reports the source of important values.

The TypeScript schemas are authoritative. The generated local-config schema is [`config.schema.json`](../config.schema.json).

## Configuration layers

| Layer | Location | Commit? | Intended contents |
|---|---|---:|---|
| Built-in defaults | Runtime | No | Safe defaults for workflow, routing, gates, testing, review, and workspaces |
| Adapter-derived defaults | Runtime/provider environment | No | Claude aliases and provider-specific model resolution |
| User preferences | `~/.config/leanrigor/config.json` | No | Personal model mappings, selected execution preferences, and workspace root |
| Repository policy | `leanrigor.config.json` | Yes | Team safety policy, portable routing requirements, risk paths, validation requirements, and caps |
| Local configuration | `.leanrigor/config.json` | No | Private full-schema overrides for one repository |

The central resolver applies files in this order:

```text
built-in defaults
→ adapter-derived defaults
→ user preferences
→ committed repository policy
→ local configuration
→ repository policy constraints re-applied
```

Repository policy is not a normal last-writer-wins file. It can enforce a minimum triage tier or committed routing, force evidence or validation, and cap parallelism or repair budgets. Local and personal settings cannot weaken the constraints currently enforced by the merger.

Claude model aliases may also be resolved through `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_OPUS_MODEL`. Individual CLI commands may have command-specific flags, but those are not a replacement for the persisted configuration layers above.

## Inspect and change configuration

Marketplace users can run:

```text
/leanrigor:init
```

CLI users can inspect effective values and provenance:

```bash
leanrigor config show
leanrigor config show --json
leanrigor config get execution.maxParallelPhases
```

Use an explicit scope for mutations:

```bash
leanrigor config set models.claude.small '"your-model-id"' --scope user
leanrigor config set execution.maxParallelPhases 2 --scope local
leanrigor config set safety.requireValidation true --scope repo
leanrigor config unset models.claude.small --scope user
```

Repository-policy changes affect every contributor and should be reviewed like code.

## User preferences

`~/.config/leanrigor/config.json` currently contributes concrete model mappings, provider polling and timeout preferences, parallelism, lease/lock timings, and an optional workspace root:

```json
{
  "version": 1,
  "adapter": "claude",
  "models": {
    "claude": {
      "small": "custom-small-model",
      "medium": "custom-medium-model",
      "large": "custom-large-model"
    }
  },
  "execution": {
    "pollIntervalSeconds": 5,
    "workerTimeoutSeconds": 1800,
    "heartbeatGraceSeconds": 30,
    "phaseLeaseTimeoutSeconds": 900,
    "workflowLockTimeoutSeconds": 30,
    "parallelism": 1
  },
  "paths": {
    "workspaceRoot": "/path/to/workspaces"
  }
}
```

These values are preferences. A repository policy may impose stronger safety requirements or lower caps.

## Repository policy

`leanrigor.config.json` is the shareable team policy. It must not contain credentials, machine-specific paths, or concrete vendor model IDs.

Example:

```json
{
  "version": 1,
  "workflow": {
    "defaultMode": "adaptive",
    "allowUserOverride": true,
    "automaticTriage": true
  },
  "minimumTiers": {
    "triage": "small"
  },
  "routing": {
    "integratedReview": "medium",
    "highRiskReview": "large"
  },
  "safety": {
    "rigorousPaths": [
      "auth/**",
      "migrations/**",
      "infrastructure/production/**"
    ],
    "protectedPaths": [
      ".git/**",
      ".env",
      "secrets/**"
    ],
    "requireEvidence": true,
    "requireValidation": true
  },
  "parallelism": {
    "maxPhases": 2
  }
}
```

Repository policy can govern workflow defaults, committed routing, risk paths, validation and completion requirements, review depth, testing expectations, task sizing, introspection, triage, Git confirmation, budgets, and maximum parallelism. The central merger currently enforces `minimumTiers.triage`; use `routing` for other workflow-stage requirements.

> [!NOTE]
> The user schema currently accepts `execution.defaultProvider`, `execution.defaultMode`, `execution.verbosity`, and `paths.claudeExecutable`, but the central effective-config resolver does not yet apply those fields. Repository-policy `minimumTiers.planning`, `minimumTiers.implementation`, `minimumTiers.review`, and `modelFallback` are also schema-valid but not yet applied by the central merger. Use explicit provider/command options and committed `routing` requirements for those cases.

## Portable model tiers

LeanRigor policy selects capabilities rather than hard-coded vendor model IDs:

- `small`
- `medium`
- `large`
- `inherit`

Default routing includes:

| Stage | Tier |
|---|---|
| Triage and narrow inspection | `small` |
| Fast implementation | `inherit` |
| Standard planning and implementation | `medium` |
| Rigorous planning and implementation | `large` |
| Integrated review | `medium` |
| High-risk review | `large` |
| Commit planning | `small` |

For Claude Code, aliases default to `haiku`, `sonnet`, and `opus`, then resolve through Claude/provider configuration. `inherit` omits an explicit model selection.

## Workflow and triage

Important settings include:

- `workflow.defaultMode`: `adaptive`, `fast`, `standard`, or `rigorous`;
- `workflow.allowUserOverride`: permits user requests that do not bypass mandatory escalation;
- `workflow.automaticTriage`: enables model-backed triage with deterministic fallback;
- `triage.chooseLowestSafeMode`: prefer the least costly safe mode;
- `triage.requireExplicitRigorousTrigger`: require a defined high-risk reason for Rigorous;
- `triage.fastRequiresPositiveEvidence`: Fast is not selected merely because no risk was noticed;
- `triage.fallbackMode`: `standard` or `rigorous` when triage cannot safely resolve.

Model output recommends a mode. Deterministic policy applies the final decision.
When the request names a GitHub issue, triage tries to enrich the evidence from
the current repository's GitHub issue metadata before the model call. GitHub
access is opportunistic: unavailable remotes, missing authentication, or offline
operation are recorded as explicit provenance and do not disable local triage.
Model clarification requests are classified deterministically; repository scope
and planning details are inspected or deferred instead of being asked of the
user.

Dedicated triage budgets live under `budgets`:

- `triageRecommendationMaxTurns`: safety bound for the normal tool-free
  recommendation call;
- `triageRecommendationRepairAttempts`: small allowance for malformed structured
  recommendation output;
- `triageInspectionMaxTurns`, `triageInspectionMaxReads`,
  `triageInspectionMaxBytes`, and `triageInspectionTimeoutSeconds`: separate
  bounds for optional targeted fact inspection.
- `phaseBriefInspectionMaxReads`, `phaseBriefInspectionMaxBytes`, and
  `phaseBriefInspectionTimeoutSeconds`: deterministic limits for the read-only
  repository inspection that informs one Phase Execution Brief;
- `phaseBriefRepairAttempts`: bounded same-provider repair attempts after
  deterministic brief-quality diagnostics. The default is one and the current
  maximum is two;
- `phaseBriefRefreshedInspectionAttempts`: bounded refreshes of repository
  evidence after diagnosed repair remains invalid. The default is one;
- `phaseBriefAlternateStrategyAttempts`: bounded alternative planning-strategy
  attempts when the selected provider exposes that capability. The default is
  one;
- `phaseBriefDeterministicFallbackAttempts`: bounded conservative deterministic
  synthesis after provider strategies are exhausted. The default is zero: enable
  it explicitly only when a deterministic fallback is acceptable.

These budgets do not grant normal triage repository tools. They cap each stage
after deterministic evidence collection has already bounded the discovery work.
Phase brief limits likewise do not grant implementation tools, workspace
creation, approval authority, or unrestricted repository traversal. An
unchanged deterministic attempt is skipped, not counted as useful progress, and
the ladder advances to the next configured strategy.

## Review, testing, and completion gates

Default review levels:

- `review.fast`: `sanity`;
- `review.standard`: `integrated`;
- `review.rigorous`: `deep`;
- `review.highRiskPaths`: `deep`, optionally `specialist`.

Default testing policy:

- `testing.bugFixes`: `regression-required`;
- `testing.publicApi`: `contract-required`;
- `testing.uiCopy`: `optional`.

Completion-gate settings include:

- `completionGate.enabled`;
- `completionGate.requireEvidence`;
- `completionGate.requireValidation`;
- `completionGate.allowSkippedValidation.fast|standard|rigorous`;
- `completionGate.maxRepairAttempts.fast|standard|rigorous`.

Standard and Rigorous reject skipped validation by default. Fast may accept a documented skipped-validation reason when policy allows it.

## Execution, leases, and workspaces

Important execution settings:

| Setting | Default | Meaning |
|---|---:|---|
| `execution.maxParallelPhases` | `1` | Maximum scheduler-approved concurrent phases |
| `execution.pollIntervalSeconds` | `5` | Recommended provider polling interval |
| `execution.workerTimeoutSeconds` | `1800` | Worker timeout befor cancellation/recovery |
| `execution.heartbeatGraceSeconds` | `30` | Grace window for missing provider heartbeat |
| `execution.workflowLockTimeoutSeconds` | `30` | Short-lived state mutation lock timeout |
| `execution.phaseLeaseTimeoutSeconds` | `900` | Durable phase lease timeout |
| `execution.writeReadConflictsBlock` | `true` | Block write/read ownership overlap |
| `execution.workspaceStrategy` | `git-worktree` | Isolated workspace strategy |
| `execution.workspaceRoot` | `null` | Resolve the default external workspace root |
| `execution.retainCompletedPhaseWorktrees` | `true` | Preserve completed phase worktrees by default |
| `execution.retainIntegrationWorktree` | `true` | Preserve integration workspace by default |
| `execution.integrationTransferStrategy` | `internal-commit` | Current controlled transfer strategy |
| `execution.internalCommitSigning` | `disabled` | Use `git-config` when internal commits must be signed |
| `execution.workerControls.environment` | `bare` | Claude worker environment mode: `bare`, `safe-mode`, or `default` |
| `execution.workerControls.maxDiscoveryTurns.fast|standard|rigorous` | `1|2|4` | Mode-aware discovery budget used in worker prompts and diagnostics |
| `execution.workerControls.reservedValidationTurns.fast|standard|rigorous` | `1|1|2` | Turns reserved for validation near the end of a phase |
| `execution.workerControls.reservedFinalResultTurns.fast|standard|rigorous` | `1|1|1` | Turns reserved for final structured output |
| `execution.workerControls.repeatedReadWarningThreshold` | `2` | Repeated-file-read diagnostic threshold |
| `execution.workerControls.largeToolOutputBytes` | `32768` | Target bound for large worker tool output summaries |

Built-in scheduling-sensitive paths include package manifests and lockfiles, `tsconfig*.json`, `.git/**`, `.github/**`, `migrations/**`, `schema/**`, and `infra/**`.

A value above `1` permits the coordinator to dispatch multiple eligible phases only when dependencies, leases, ownership, provider capability, and repository policy allow it. This should not be confused with stable native Claude subagent orchestration, which remains roadmap work.

## Git policy

- `git.autoCommit` defaults to `false` and repository policy only accepts `false`.
- `git.requireConfirmation` defaults to `true`.
- `git.commitStyle` may be `conventional` or `plain`.

LeanRigor may create internal mechanical commits on LeanRigor-owned phase and integration branches after completion gates pass. It does not automatically create the final user commit or push.

## Validation and troubleshooting

Use:

```bash
leanrigor config show --json
leanrigor doctor --adapter claude --root /path/to/repository
```

The reports include loaded sources, effective values, provenance where available, active policy constraints, model-tier resolution, and installation warnings. Invalid configuration is rejected through schema validation rather than silently ignored.
