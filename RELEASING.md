# Releasing LeanRigor

LeanRigor is currently pre-release software. Releases should communicate verified behaviour conservatively and must not promote roadmap capabilities as available.

## Versioning

Use semantic versioning:

- `0.x.y-alpha.n` for early previews with known gaps;
- `0.x.y-beta.n` for feature-complete previews undergoing broader validation;
- stable `0.x.y` releases only after the documented installation and workflow paths are repeatably verified;
- `1.0.0` only when public contracts, migration expectations, support boundaries, and release operations are mature.

Recommended npm channels when publication begins:

- `next` for prereleases;
- `latest` for stable releases.

## Release requirements

Before tagging or publishing:

1. Confirm the README feature inventory matches the latest `main` branch.
2. Update `CHANGELOG.md`.
3. Run:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run lint
   npm run build
   npm run validate:claude-plugin
   git diff --check
   ```

4. Create and inspect the package:

   ```bash
   npm pack
   tar -tf leanrigor-*.tgz
   ```

5. Install the tarball in a clean environment and verify:
   - `leanrigor --help`;
   - project-local Claude initialisation and doctor;
   - marketplace/plugin packaging validation;
   - a disposable-repository workflow smoke;
   - no automatic final commit or push.
6. Confirm package, plugin manifest, and documentation versions agree.
7. Record live-provider or platform verification honestly; mark unverified paths as limitations.
8. Create a signed or otherwise attributable GitHub release with release notes derived from the changelog.

## Release blockers

Do not release when:

- CI is failing;
- README claims contradict implementation or tests;
- package contents differ from documented installation paths;
- workflow-state migration is missing;
- user-working-tree safety is uncertain;
- a security issue affecting the release remains unresolved;
- the final user commit, push, deploy, or destructive operation can occur without explicit approval.

## Rollback and deprecation

For a defective npm release, deprecate the affected version with a corrective message rather than deleting package history. Publish a patch or corrected prerelease. Document migration steps for breaking workflow-state or configuration changes before release.
