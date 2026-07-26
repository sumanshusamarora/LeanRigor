# Releasing LeanRigor

LeanRigor is pre-release software. Releases must describe verified behaviour conservatively and must not present roadmap capabilities as available.

## Versioning

Use semantic versioning with explicit pre-release stages:

- `0.x.y-dev.N` for rapid development snapshots and marketplace iteration;
- `0.x.y-alpha.N` for public previews with known functional gaps;
- `0.x.y-beta.N` for feature-complete previews undergoing broader validation;
- stable `0.x.y` only after documented installation and workflow paths are repeatably verified;
- `1.0.0` only when public contracts, migration expectations, support boundaries, and release operations are mature.

Recommended npm channels when publication begins:

- `next` for pre-releases;
- `latest` for stable releases.

The npm package is currently private and unpublished. Marketplace development versions and source-built tarballs must still keep package, plugin, marketplace, CLI, runtime, and documentation versions consistent.

## Development version workflow

For a change that affects distributable marketplace or project-local plugin assets:

```bash
npm run version:dev
```

This increments the development suffix and synchronises versioned manifests.

To synchronise or verify without choosing a new version:

```bash
npm run version:sync
npm run version:check
```

Documentation-only changes do not require a version bump unless they modify packaged command, agent, hook, skill, methodology, template, or runtime assets whose delivered behaviour changes.

## Release requirements

Before tagging, publishing, or promoting a marketplace release:

1. Confirm the README feature inventory matches the latest `main` branch.
2. Confirm `IMPLEMENTATION_STATUS.md`, current limitations, linked setup documentation, and roadmap agree with code and tests.
3. Update `CHANGELOG.md`.
4. Verify version consistency:

   ```bash
   npm run version:check
   ```

5. Run the full local verification set:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run lint
   npm run build
   npm run check:plugin-version-bump
   npm run validate:claude-plugin
   git diff --check
   ```

6. Create and inspect the package:

   ```bash
   npm pack
   tar -tf leanrigor-*.tgz
   ```

7. Install the tarball in a clean environment and verify:
   - `leanrigor --help`;
   - project-local Claude initialisation and diagnostics;
   - marketplace/plugin packaging validation;
   - a disposable-repository workflow smoke;
   - no automatic final user commit or push.
8. Verify the Claude marketplace path from a clean or refreshed plugin cache.
9. Run the authenticated Claude CLI execution smoke when the release claims live `claude-cli` provider behaviour.
10. Record live-provider and platform verification honestly. Keep unverified paths under Current Limitations.
11. Create an attributable GitHub release with notes derived from the changelog.

## Release blockers

Do not release when:

- CI is failing;
- README or linked documentation contradicts implementation or tests;
- package contents differ from documented installation paths;
- package, plugin, marketplace, CLI, runtime, or build metadata versions disagree;
- required workflow-state or configuration migration is missing;
- user-working-tree safety is uncertain;
- a release-affecting security issue remains unresolved;
- provider process success can bypass completion gates;
- the final user commit, push, deployment, or destructive operation can occur without explicit approval;
- a prototype or roadmap capability is presented as stable.

## Rollback and deprecation

For a defective npm release, deprecate the affected version with a corrective message rather than deleting package history. Publish a patch or corrected pre-release.

For a defective marketplace release, publish a corrected development or preview version, document the refresh/reinstall path, and preserve repository-local `.leanrigor/` state unless migration requires explicit action.

Document migration steps for breaking workflow-state, configuration, command-surface, or provider-contract changes before release.
