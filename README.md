<div align="center">

# LeanRigor

### The right amount of engineering rigor for every AI coding task.

**Adaptive planning, execution control, validation, and review for coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-6B4EFF)](#quick-start)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](docs/setup.md)
[![Stage: Early](https://img.shields.io/badge/stage-early--stage-F0AD4E)](#project-status)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

LeanRigor keeps small, clearly bounded changes lightweight while applying stronger planning, approvals, isolation, validation, and review when the work carries more risk.

It separates **task complexity** from **workflow risk**, then selects a proportional workflow:

| âš¡ Fast | ğŸ› ï¸ Standard | ğŸ›¡ï¸ Rigorous |
|---|---|---|
| Clearly bounded, low-risk changes | Normal features, fixes, and refactors | Security, migrations, public contracts, production systems, concurrency, data integrity, destructive operations, and high blast radius |
| Compact plan and targeted validation | Phased plan, explicit approval, and integrated review | Explicit approach gate, isolated risk boundaries, stronger evidence, and deeper review |
| Must have positive evidence that Fast is safe | Default for normal engineering work | Deterministic risk triggers can require it |

> **Execution providers do the work. LeanRigor decides what may run, what evidence is required, and whether the result is accepted.**

## See it adapt

The same command surface produces different engineering depth:

| Request | LeanRigor response |
|---|---|
| `Fix a typo in README.md` | **Fast** â€” one compact phase, targeted validation, diff sanity review |
| `Add an optional API field and update its consumer` | **Standard** â€” contract, consumer, regression coverage, explicit plan approval |
| `Add a database migration affecting authenticated production requests` | **Rigorous** â€” deterministic escalation, isolated migration boundary, broader validation, deep review |

## Quick start

### Claude Code marketplace

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

Then, from any repository:

```text
/leanrigor:start Add an optional API field and update its consumer
```

LeanRigor creates repository-local state under `.leanrigor/`, presents the selected mode and approvals conversationally, coordinates phased work, requires completion evidence, runs final integrated review, and proposes commits without creating the final user comit or pushing.

Other useful commands:

```text
/leanrigor:init
/leanrigor:plan
/leanrigor:status
/leanrigor:review
/leanrigor:commit
```

> [!NOTE]
> The npm package is not yet published as a stable public package. The Claude Code marketplace is the recommended user installation path. See [Setup](docs/setup.md) for source and project-local development installation.

## Why LeanRigor exists

[Superpowers](https://github.com/obra/superpowers) shows how much better coding agents can perform with disciplined brainstorming, planning, testing,verification, and review.

In my own use, however, applying a comprehensive workflow to every task could make small changes take roughly **5â€“20Ã— longer than working with the coding agent directly**. That is a personal observation from my workflows, not a controlled benchmark.

The problem was not engineering discipline. The problem was applying similar depth regardless of the task.

LeanRigor began with a different question:

> **Can we preserve strong engineering practices while applying only the ceremony justified by the task's risk and complexity?**

A documentation typo should not be treated like a production migration. A production migration should never be treated like a documentation typo.

### LeanRigor and Superpowers

Both projects value planning, testing,verification, and review. They make different product choices about **when** those practices apply, **how deeply** they apply, and **who decides that work is complete**.

| Area | Superpowers | LeanRigor |
|---|---|---|
| Primary idea | A comprehensive software-development methodology for coding agents | An adaptive workflow and policy control plane |
| Workflow depth | Strong, consistently guided engineering process | Fast, Standard, or Rigorous based on complexity and explicit risk |
| Small tasks | Still benefit from structured methodology and skills | Stay lightweight only when positive evidence shows they are bounded and low risk |
| High-risk tasks | Strong planning, testing, verification, and review practices | Deterministic escalation, explicit approvals, persisted evidence, isolated workspaces, and integration gates |
| Completion | Verification discipline before completion claims | Provider results are evidence; deterministic completion gates decide whether a phase passes |
| Model selection | May vary by agent role and platform | Portable `small`, `medium`, `large`, and `inherit` capability tiers are part of policy |
| Architecture | Methodology and agent skills | Separates LeanRigor-owned governance from provider-owned worker execution |
| Best fit | Developers wanting a strong end-to-end methodology | Developers and teams wanting engineering depth proportional to risk with resumable control and audit state |

This comparison explains the different design emphasis. It is not a claim that one approach universally replaces the other.

## How it works

```mermaid
flowchart LR
    A[User request] --> B[Complexity assessment]
    B --> C[Deterministic risk policy]
    C --> D{Workflow mode}
    D -->|Bounded + low risk| E[Fast]
    D -->|Normal engineering| F[Standard]
    D -->|Explicit risk trigger| G[Rigorous]
    E --> H[Plan and approvals]
    F --> H
    G --> H
    H --> I[Execution provider]
    I --> J[Structured result + evidence]
    J --> K{Completion gate}
    K -->|Pass| L[Controlled integration]
    K -->|Repair / review / replan| H
    K -->|Blocked| M[External action]
    L --> N[Combined validation]
    N --> O[Final integrated review]
    O --> P[Human-reviewed commit proposal]
```

LeanRigor owns:

- triage, complexity and risk classification, and final mode selection;
- planning, phase DAGs, approvals, and dispatch eligibility;
- ownership and conflict policy;
- evidence requirements and deterministic completion gates;
- integration ordering, combined validation, final review, resumability, and audit state.

Execution providers own:

- launching workers;
- provider-specific lifecycle, status, heartbeat, timeout, and cancellation;
- returning structured results.

A provider process exiting successfully does **not** complete a phase. LeanRigor collects the result, checks evidence and validation, applies deterministic policy, and only then accepts, repairs, reviews, replans, or blocks the phase.

## Implemented and verified

### Adaptive workflow and governance

- Fast, Standard, and Rigorous workflow modes.
- Complexity and workflow risk assessed separately.
- Model-backed triage with schema validation, one retry, deterministic policy overrides, and deterministic fallback.
- Explicit approach and plan approvals where required.
- Portable model tiers: `small`, `medium`, `large`, and `inherit`.
- Repository policy minimums that personal configuration cannot weaken.

### Evidence, persistence, and integration

- Repository-local, versioned workflow state under `.leanrigor/`.
- Atomic revisions, persistent workflow locks, durable phase leases, heartbeats, and stale-lease recovery.
- Small functional phases with dependencies, acceptance criteria, expected areas, and validation expectations.
- Per-phase evidence-based completion gates with bounded repair, review, replan, and blocked outcomes.
- Isolated phase and integration Git worktrees that leave the user's original working tree untouched.
- Internal mechanical transfer commits on LeanRigor-owned branches only.
- Controlled integration order, textual conflict preservation, combined validation tied to the current integration head, and final integrated review.

### Execution providers

- Provider-neutral `ExecutionCoordinator` and `ExecutionProvider` boundary.
- Deterministic scripted provider and disposable real-Git test harness.
- Persisted dispatch, polling, heartbeat, timeout, cancellation, recovery, result collection, completion-gate, integration, and final-review progression.
- Claude CLI execution provider prototype for authenticated headless smoke testing.

### Claude Code integration

- Native marketplace commands and auto-bootstrap on first use.
- Project-local fallback for development and repositories that need local `.claude/` assets.
- Read-only triage agent.
- Git-protection hook blocking automatic `git commit`, `git push`, and `git reset --hard` Šr6ÆVFRÖ6öçG&öÆÆVBW†V7WF–öâF‡2à¢Ò–ç7FÆÆF–öâæBfW'6–öâF–væ÷7F–72F‡&÷Vv‚öÆVç&–v÷#¦–æ—FæBÆVç&–v÷"Fö7F÷&à ¥6VR´–×ÆVÖVçFF–öâ7FGW5Ò„”ÕÄTÔTåDD”ôåõ5DEU2æÖB’f÷"F†RFWF–ÆVBfW&–f–6F–öâ–çfVçF÷'’à ¢226fWG’&÷VæF&–W0 ¤ÆVå&–v÷"FVÆ–&W&FVÇ’FöW2¢¦æ÷B¢¢WFöÖF–6ÆÇ“  ¢Ò7&VFRF†Rf–æÂW6W"6öÖÖ—C°¢ÒW6‚Fò&VÖ÷FS°¢ÒFWÆ÷“°¢ÒW&f÷&ÒFW7G'V7F—fR&öGV7F–öâw&—FW3°¢Ò&W6öÇfR–çFVw&F–öâ6öæfÆ–7G2'’6†ö÷6–ær÷W'6÷"F†V—'6°¢ÒW'6—7B†–FFVâ6†–âöbF†÷Vv‡Bà ¤–çFW&æÂÖV6†æ–6Â6öÖÖ—G2Ö’&R7&VFVBöæÇ’öâÆVå&–v÷"Ö÷væVB†6RæB–çFVw&F–öâ'&æ6†W2Fò7W÷'B6öçG&öÆÆVBG&ç6fW"æBfÆ–FF–öââF†W’&Ræ÷BF†Rf–æÂW6W"6öÖÖ—BæB&RæWfW"W6†VBWFöÖF–6ÆÇ’à ¢22&ö¦V7B7FGW0 £â²”Õõ%DåEĞ£â¢¤ÆVå&–v÷"—2V&Ç’×7FvRæB7F—fVÇ’WföÇf–ærâ¢ £à£â6ÆVFR6öFR—2F†Rf—'7B7W÷'FVB6öF–ærÖvVçB–çFVw&F–öââF†Rv÷&¶fÆ÷rVæv–æRÂFWFW&Ö–æ—7F–2öÆ–7’ÂWf–FVæ6RvFW2Â—6öÆFVBv—Bv÷&·76W2ÂæB&÷f–FW"&÷VæF'’&R–×ÆVÖVçFVBÂ'WB6WfW&Â6&–Æ—F–W2&VÖ–âW‡W&–ÖVçFÂ÷"ÆææVBà ¤¶æ÷vâÆ–Ö—FF–öç3  ¢Ò6ÆVFR6öFR—2F†RöæÇ’7W÷'FVB6öF–ærÖvVçB–çFVw&F–öâFöF’à¢ÒF†R6ÆVFR4Ä’W†V7WF–öâ&÷f–FW"—2&÷F÷G—RæB&WV—&W2âWF†VçF–6FVBÆö6Â6ÆVFR4Ä’f÷"Æ—fR6Öö¶RFW7F–ærà¢ÒæF—fR6ÆVFR7V&vVçB÷&6†W7G&F–öâ—2æ÷B–WB–çFVw&FVBà¢Ò66†VGVÆ–æræBF†R6ö÷&F–æF÷"&R&ÆÆVÂÖ6&ÆRÂ'WBWFöæöÖ÷W2×VÇF’ÖvVçBW†V7WF–öâ—2æ÷B–WB&W6VçFVB27F&ÆRW6W"Öf6–ær6&–Æ—G’à¢ÒFW‡GVÂ–çFVw&F–öâ6öæfÆ–7G2&RFWFV7FVBæB&W6W'fVC²6VÖçF–26öæfÆ–7B&W—"—2æ÷B–×ÆVÖVçFVBà¢Ò÷Vä6öFRÂ6öFW‚Â7W'6÷"Â6÷–Æ÷BÂæB÷F†W"FFW'2&VÖ–â&öFÖ—FV×2à¢ÒF†RçÒ6¶vR&VÖ–ç2&—fFRæBVçV&Æ—6†VC²6÷W&6R–ç7FÆÆF–öâ—2f÷"FWfVÆ÷ÖVçBæB&R×&VÆV6RFW7F–ærà ¢226öæf–wW&F–öà ¤ÆVå&–v÷"6W&FW2FVÒöÆ–7’g&öÒW'6öæÂ&÷f–FW"6†ö–6W3  §ÂÆ–W"ÂÆö6F–öâÂ–çFVæFVBW6RÀ§ÂÒÒ×ÂÒÒ×ÂÒÒ×À§ÂW6W"&VfW&Væ6W2Ââòæ6öæf–röÆVç&–v÷"ö6öæf–ræ§6öæÂW'6öæÂFVfVÇG2æB6öæ7&WFRÖöFVÂ6†ö–6W2À§Â&W÷6—F÷'’öÆ–7’ÂÆVç&–v÷"æ6öæf–ræ§6öæÂ6öÖÖ—GFVBFVÒ6fWG’öÆ–7’Â÷'F&ÆR&÷WF–ær&WV—&VÖVçG2ÂæB62À§ÂÆö6Â÷fW'&–FW2ÂæÆVç&–v÷"ö6öæf–ræ§6öæÂ&—fFR&W÷6—F÷'’×7V6–f–2fÇVW2æB'VçF–ÖR7FFR&VfW&Væ6W2À§Â'VçF–ÖR7FFRÂæÆVç&–v÷"÷v÷&¶fÆ÷w2öÂW'6—7FVBv÷&¶fÆ÷w2ÂWf–FVæ6RÂvFW2ÂæB&W7VÖ&–Æ—G’À ¥F†R6VçG&Â&W6öÇfW"Æ–W2'V–ÇBÖ–âæBFFW"FVfVÇG2ÂF†VâW6W"&VfW&Væ6W2Â&W÷6—F÷'’öÆ–7’ÂæBÆö6Â6öæf–wW&F–öâ&Vf÷&R&RÖÇ––ær&W÷6—F÷'’×öÆ–7’6öç7G&–çG2âW'6öæÂæBÆö6Â6WGF–æw26ææ÷BvV¶Vâ6öÖÖ—GFVB6fWG’Ö–æ–×V×2÷"62â6ÆVFRÖöFVÂÆ–6W2Ö’Ç6ò&W6öÇfRF‡&÷Vv‚F†R7FæF&BåD…$õ”5ôDTdTÅEò¦Vçf—&öæÖVçBf&–&ÆW2à ¥6VRF†R¶6öæf–wW&F–öâ&VfW&Væ6UÒ†Fö72ö6öæf–wW&F–öâæÖB’à £ÆFWF–Ç3à£Ç7VÖÖ'“ãÇ7G&öæsä–ç7FÆÂg&öÒ6÷W&6R÷"7&VFR&ö¦V7BÖÆö6Â6ÆVFR76WG3Â÷7G&öæsãÂ÷7VÖÖ'“à ¤æöFRæ§2#÷"ÆFW"—2&WV—&VBà ¦&6€¦çÒ–ç7FÆÀ¦çÒ'Vâ'V–Æ@¦çÒ6°¦çÒ–ç7FÆÂÖrâöÆVç&–v÷"ÒB†æöFR×'&WV—&R‚râ÷6¶vRæ§6öâr’çfW'6–öâ"’çFw  ¦ÆVç&–v÷"–æ—BÒÖFFW"6ÆVFRÒ×&ö÷B÷F‚÷Fò÷&W÷6—F÷'¦ÆVç&–v÷"Fö7F÷"ÒÖFFW"6ÆVFRÒ×&ö÷B÷F‚÷Fò÷&W÷6—F÷'¦  ¥F†—2F‚—2–çFVæFVBf÷"FWfVÆ÷ÖVçBæB&R×&VÆV6RFW7F–ærâ—B7&VFW2ÆVå&–v÷"Ö÷væVB&ö¦V7BÖÆö6Âæ6ÆVFRö76WG2v†–ÆR&W6W'f–ærVç&VÆFVBW6W"f–ÆW2à £ÂöFWF–Ç3à ¢22Fö7VÖVçFF–öà §Â7F'B†W&RÂFVWF—fW2À§ÂÒÒ×ÂÒÒ×À§Âµ&öGV7B&F–öæÆUÒ…$ôET5BæÖB’Â´&6†—FV7GW&UÒ„$4„•DT5EU$RæÖB’À§Âµ6WGWÒ†Fö72÷6WGWæÖB’Âµv÷&¶fÆ÷ræB6ö×ÆWF–öâvFW5Ò†Fö72÷v÷&¶fÆ÷ræÖB’À§Â´6ÆVFR6öFRFFW%Ò†Fö72ö6ÆVFRÖ6öFRæÖB’Â´Væv–æVW&–ærÖWF†öFöÆöw•Ò†Fö72öÖWF†öFöÆöw’æÖB’À§Â´6ÆVFRÖ&¶WGÆ6RÇVv–åÒ†Fö72ö6ÆVFRÖÖ&¶WGÆ6RæÖB’Â´6öæf–wW&F–öâ&VfW&Væ6UÒ†Fö72ö6öæf–wW&F–öâæÖB’À§Â´7W'&VçB–×ÆVÖVçFF–öâ7FGW5Ò„”ÕÄTÔTåDD”ôåõ5DEU2æÖB’Â´6öçG&–'WF÷"&6†—FV7GW&UÒ†Fö72ö6öçG&–'WF÷"Ö&6†—FV7GW&RæÖB’À§Âµ7W÷'EÒ…5Uõ%BæÖB’Âµ6V7W&—G•Ò…4T5U$•E’æÖB’À§Â´6öçG&–'WF–æuÒ„4ôåE$”%UD”äræÖB’Â´v÷fW&ææ6UÒ„tõdU$ää4RæÖB’æB·&VÆV6–æuÒ…$TÄT4”äræÖB’À ¢226öçG&–'WF–æp ¥F†—2—2öæÇ’F†R&Vv–ææ–ærâVÆÂ&WVW7G2Â—77VR&W÷'G2Â&6†—FV7GW&R7&—F—VW2ÂæB–×&÷fVÖVçB–FV2&RvVÆ6öÖ^(	Fæ÷BöæÇ’6öFRà ¥W6VgVÂ6öçG&–'WF–öç2–æ6ÇVFS  ¢Ò&VÂ×v÷&ÆBf7BÂ7FæF&BÂæB&–v÷&÷W26Æ76–f–6F–öâW†×ÆW3°¢Òöæ&ö&F–ærÂ$TDÔRÂW†×ÆW2ÂæBFö7VÖVçFF–öâ–×&÷fVÖVçG3°¢Ò&÷f–FW"æB6öF–ærÖvVçBFFW'3°¢Òv–æF÷w2æB7&÷72×ÆFf÷&ÒFW7F–æs°¢Òv÷&¶fÆ÷r&Væ6†Ö&·2æB&W&öGV6–&ÆRW&f÷&Öæ6RWf–FVæ6S°¢ÒW†V7WF–öâÂv÷&·76RÂæB–çFVw&F–öâ6fWG’FW7G3°¢Ò6–×ÆW"&WW6&ÆRÇFW&æF—fW2Fò7W7FöÒ–æg&7G'V7GW&Rà ¤f÷VæBvV²77V×F–öâ÷"VææV6W76'’–V6Röb6ö×ÆW†—G“òÆV6R÷Vââ—77VRâ¢¤ÆVå&–v÷"6†÷VÆB–×&÷fRF‡&÷Vv‚Wf–FVæ6RÂæ÷Bf÷VæFW"6öçf–7F–öââ¢  ¥&VB´4ôåE$”%UD”äræÖEÒ„4ôåE$”%UD”äræÖB’æBF†R¶6öçG&–'WF÷"&6†—FV7GW&RwV–FUÒ†Fö72ö6öçG&–'WF÷"Ö&6†—FV7GW&RæÖB’&Vf÷&R6†æv–ærv÷&¶fÆ÷r7FFRÂöÆ–7’ÂW†V7WF–öâÂ÷"v—B–çFVw&F–öâà ¢22&öFÖ  ¤æV"×FW&ÒF†VÖW2–æ6ÇVFS  ¢ÒæF—fR6ÆVFR†6R×v÷&¶W"÷&6†W7G&F–öã°¢Ò–çFVw&FVB6VÖçF–26öæfÆ–7B&W—#°¢ÒFF—F–öæÂ6öF–ærÖvVçBæBW†V7WF–öâ×&÷f–FW"FFW'3°¢Ò7&÷72×ÆFf÷&Ò4’æB&VÆV6RWFöÖF–öã°¢Ò&W&öGV6–&ÆRv÷&¶fÆ÷r×VÆ—G’ÂÆFVæ7’ÂæBFö¶Vâ×W6R&Væ6†Ö&·2à ¥&öFÖ—FV×2&Ræ÷B&W6VçFVB2–×ÆVÖVçFVB6&–Æ—F–W2âG&6²æBF—67W72F†VÒF‡&÷Vv‚v—D‡V"—77VW2à ¢22Æ–6Vç6P ¤ÆVå&–v÷"—2&VÆV6VBVæFW"F†R´Ô•BÆ–6Vç6UÒ„Ä”4Tå4R’à