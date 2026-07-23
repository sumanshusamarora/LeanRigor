# Setup and configuration

The setup flow should detect repository guidance such as `AGENTS.md`, `CLAUDE.md`, and `CONTRIBUTING.md`, then reference rather than duplicate it.

Configuration lives in `.leanrigor/config.json`. The `$schema` field is intended to provide editor validation and documentation. A generated standalone schema is included at `config.schema.json`.

Use `leanrigor doctor` to display the active triage profile, resolved Claude model, instruction documents, and adapter installation state.
