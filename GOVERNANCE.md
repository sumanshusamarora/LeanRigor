# Governance

LeanRigor is currently maintained under a lightweight maintainer-led model suitable for an early-stage open-source project.

## Decision authority

The repository owner is the current lead maintainer and has final responsibility for releases, security responses, roadmap direction, architecture boundaries, and merge decisions.

Contributors influence decisions through issues, design discussions, pull requests, testing evidence, and documented alternatives. Maintainer authority should be exercised transparently and with reasons, especially when declining substantial proposals.

## Product and architecture principles

Decisions should preserve these boundaries:

- LeanRigor is the workflow and policy control plane.
- Deterministic policy has final authority over prompt confidence.
- Fast mode requires positive evidence that work is low risk.
- Explicit high-risk triggers escalate rigor.
- User approvals remain explicit where required.
- LeanRigor does not automatically create the final user commit, push, deploy, perform destructive production writes, or persist hidden chain of thought.
- Stable native or reusable infrastructure is preferred over rebuilding generic mechanics.
- Backward compatibility is protected unless a migration is explicitly planned.

## Changes

Small, reversible changes may proceed through a focused pull request. Changes affecting workflow states, persistence, safety guarantees, public contracts, provider boundaries, Git integration, or release policy should include design rationale and migration or compatibility analysis.

Architecture decisions with long-lived consequences should be recorded under `docs/adr/`.

## Releases

Releases require passing CI, package validation, installation smoke tests, documentation updates, and an accurate changelog. Pre-release functionality must not be presented as stable.

## Future evolution

As sustained external contribution grows, governance may expand to include additional maintainers, documented nomination criteria, shared review ownership, and a more formal decision process. Until then, this document intentionally avoids creating process unsupported by the project's current scale.
