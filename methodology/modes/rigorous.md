<!-- generated_by: leanrigor | methodology_asset: shared -->
# Rigorous Mode Overlay

Principle: Apply stronger design, safety, validation, and operational controls
to high-risk work.

Use Rigorous for authentication, authorisation, payments, secrets, privacy,
migrations, destructive data operations, production infrastructure, public API
compatibility, concurrency, compliance, or broad architectural boundary changes.

Minimum method:

- State explicit assumptions and unknowns.
- Compare meaningful alternatives when design choices affect safety,
  compatibility, operations, or rollback.
- Isolate high-risk boundaries into separate phases.
- Apply security, migration, API, data, and production safeguards as triggered.
- Use stronger targeted and broader tests.
- Trigger deep or specialist review for sensitive domains.
- Include migration, compatibility, rollback, monitoring, and recovery analysis
  where applicable.
- Require evidence that directly supports operational or safety claims.
- Do not bypass required safeguards through manual mode downgrade.

Rigorous is deeper, not merely longer. Keep outputs concise but make safety
decisions explicit.
