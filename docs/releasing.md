# Releasing a package

Each package is released on its own. A release is a GitHub release whose tag is `<package>-v<version>`, for example `error-tracker-v0.1.1`, with the package's tarball attached. Consumers install the tarball by URL:

```bash
bun add https://github.com/queso/context-kit-packages/releases/download/error-tracker-v0.1.1/context-kit-error-tracker-0.1.1.tgz
```

Nothing is published to npm. The workflow is `.github/workflows/release.yml`, and it uses only the repository's own `GITHUB_TOKEN` with `contents: write`.

## Cutting a release

`<package>` below is the directory name under `packages/` (`auth`, `auth-ui`, `error-tracker`), and `<version>` is the new version.

1. On a branch, set `version` in `packages/<package>/package.json` to `<version>`.
2. In `packages/<package>/CHANGELOG.md`, rename `## [Unreleased]` to `## [<version>] - <YYYY-MM-DD>`, or add that section. The workflow uses the section's text as the release notes and fails if the section is missing or empty.
3. In `packages/<package>/README.md`, change the version in the install URL in both places: the tag (`<package>-v<version>`) and the file name (`context-kit-<package>-<version>.tgz`). For auth-ui, also update the `overrides` URL if the auth version changed. The pack check in CI fails until the README's URL matches the version in `package.json`.
4. Run the pack check locally:

   ```bash
   bun install
   bun run build
   bun run pack-check
   ```

5. Open a pull request and merge it once CI is green.
6. Optional: run a dry run from the Actions tab. Open **Release**, choose **Run workflow** on `main`, enter the tag `<package>-v<version>`, and leave **dry_run** checked. The run builds, tests and packs the package, uploads the tarball as the `release-<package>-v<version>` workflow artifact, and creates no release. The job summary shows the install line and the tarball's sha512.
7. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag <package>-v<version>
   git push origin <package>-v<version>
   ```

8. The tag push starts the Release workflow. The `build` job checks that the tag's version matches `package.json`, extracts the changelog section, runs install with a frozen lockfile, the build, the package's typecheck and tests, and the pack check. The `publish` job then creates the GitHub release with the tarball attached and the changelog section as its notes.
9. Open the run's summary to get the install line and the sha512, and check that the release page lists the `.tgz` file.

## When a run fails

- **Version mismatch.** The tag and `package.json` disagree. Delete the tag (`git push origin :refs/tags/<tag>` and `git tag -d <tag>`), fix the version on `main`, and tag again.
- **A failure before the publish job.** No release exists yet. Fix the problem on `main`, then delete and re-push the tag as above.
- **The publish job failed after the build passed.** Re-run the failed job from the Actions tab, or run the workflow manually with **Use workflow from** set to the tag and **dry_run** unchecked. A non-dry manual run fails unless it runs on the tag itself, so it always builds the tagged commit.

## What the pack check covers

`scripts/pack-check.ts` runs in CI on every pull request and again in the release build. For each package it:

- packs the package with `bun pm pack` and checks that the tarball contains `dist/`, `package.json`, `README.md`, `CHANGELOG.md` and `LICENSE`, and nothing else
- checks that the packed `package.json` has no `workspace:` ranges and that every `exports` and `bin` target is in the tarball
- checks that the README's install URL matches the package's version
- installs the tarball into an empty project with `bun add`, plus every declared peer dependency, with sibling `@context-kit/*` packages installed from their own tarballs through `overrides`
- imports every entry in the `exports` map with Bun and with Node. Plain Node cannot resolve bare `next/headers`, `next/server` or `next/navigation` imports because `next` has no exports map, so that one Node failure is reported as a warning; a Next.js app resolves those imports when it bundles
- typechecks an import of every entry with TypeScript 7 and `skipLibCheck: false`. It fails on errors in the package's own `.d.ts` files and only reports errors in other packages' `.d.ts` files, such as drizzle-orm's.

The release build runs the package's tests without a Postgres service, so the Postgres round-trip tests skip there. They run on every pull request in CI's `test-postgres` job.
