<!-- generated_by: leanrigor | methodology_asset: shared -->
# Fast Mode Overlay

Principle: Move quickly on clearly bounded, low-risk work without skipping
basic understanding and evidence.

Use Fast when there is positive evidence of low ambiguity, low blast radius,
low architectural impact, and no material security, migration, data integrity,
operational, or public-contract risk.

Minimum method:

- Briefly inspect the relevant file or local behavior.
- Make the smallest change.
- Use one clear acceptance criterion.
- Run targeted validation or record why no automated check is practical.
- Perform diff sanity before completion.
- Avoid unnecessary alternatives, design documents, and decomposition.

Fast must stay compact. If inspection reveals broader behavior, contract, data,
security, or operational impact, stop and replan in the appropriate mode.
