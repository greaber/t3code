# Fork releases (greaber/t3code)

> For this fork's maintainer. Upstream's process is in [Release](./release.md).

This fork publishes its own server builds so every machine runs the fork, not upstream. The
desktop app, `t3 service` self-update, `t3 update`, and `scripts/install.sh` all download from
`https://github.com/greaber/t3code/releases` (`CLI_RELEASE_REPOSITORY` in
`packages/shared/src/cliRelease.ts`). `T3CODE_RELEASE_BASE_URL` still overrides it.

## Versions

Fork versions are `<next upstream version>-grant.<n>`, for example `0.1.9-grant.1`:

- The core is the upstream release the base's nightlies preview (`0.1.9` while upstream ships
  `0.1.9-nightly.*`). It sorts above every upstream release the fork already contains, so hosts on
  those versions are offered an update.
- The `-grant.<n>` suffix keeps the version from colliding with an upstream build. Installed
  runtimes are cached by version in `~/.t3/runtime/versions/<version>`, so a shared version would
  be taken as already installed.
- Grant builds are the fork's stable track: `cliReleaseChannelOf` reads only `-nightly.` and
  `-preview.` as other tracks, and the version-skew check compares full versions between two grant
  builds, so `-grant.2` offers an update to a host on `-grant.1`.

To bump, edit the version in `apps/server/package.json`, `apps/desktop/package.json`,
`apps/web/package.json`, and `packages/contracts/package.json` (or run
`node scripts/update-release-package-versions.ts <version>`). Increment `<n>` for each fork
release; after rebasing onto upstream commits past a new upstream release, move the core to the
next upstream version and restart at `-grant.1`. The desktop app asks remote hosts for its own
version, so build the desktop app from the same commit as the release.

## Cutting a release

1. Commit the version bump and push the branch.
2. Tag and push: `git tag v<version> && git push greaber v<version>`. Pushing the tag runs
   `.github/workflows/fork-release.yml`. Running the workflow by hand
   (`gh workflow run fork-release.yml --ref <branch> -R greaber/t3code`) releases the branch tip
   and creates the tag.
3. The workflow checks that the tag matches every package version, builds the JS bundle once, then
   builds and smoke-tests the CLI archives for `linux-x64`, `linux-arm64`, and `darwin-arm64` with
   the same scripts as upstream's `cli_archive` jobs (unsigned; macOS is signed ad hoc). It
   publishes release `v<version>` with the archives and `SHA256SUMS`, marked latest.

Upstream's `release.yml` also matches the tag, but its jobs are gated on `pingdotgg/t3code` and
skip. Upstream workflows that run on Blacksmith runners without such a gate (`ci.yml` and others
that use `blacksmith-*` runners) would sit queued on the fork, so disable them in the fork's
**Actions** settings (Actions → the workflow → **Disable workflow**).

## Desktop app

The workflow does not build the desktop app. Build it on the Mac from the release commit:

```bash
vp run dist:desktop:dmg:arm64
```

The DMG lands in `release/`. A local build has no update feed, so the app's own auto-update is
off; install each new build by hand.

## Moving a host to the fork

A host whose service runs an upstream build downloads updates from upstream until told otherwise.
Once, on that host (Linux, systemd user service):

```bash
systemctl --user edit t3code.service
# add:
# [Service]
# Environment=T3CODE_RELEASE_BASE_URL=https://github.com/greaber/t3code/releases/download
systemctl --user restart t3code.service
```

Then click **Update** for that host in the desktop app. After it runs a fork build, the fork's
default points at this repository and the override can be removed.

On a new host, either connect over SSH from the desktop app, which installs its own version from
this repository, or install the service:

```bash
curl -fsSL https://raw.githubusercontent.com/greaber/t3code/v<version>/scripts/install.sh | sh
~/.local/bin/t3 service install
```
