#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  printf '%s\n' 'Refusing to build the installed app from a dirty checkout.' >&2
  exit 1
fi
head=$(git rev-parse HEAD)
published=$(git ls-remote --exit-code origin refs/heads/grant/main)
if [[ ${published%%$'\t'*} != "$head" ]]; then
  printf '%s\n' 'Build from the commit published at origin/grant/main.' >&2
  exit 1
fi
version=$(node -p 'require("./apps/server/package.json").version')
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+-grant\.[0-9]+$ || ${T3CODE_DESKTOP_VERSION:-$version} != "$version" ]]; then
  printf '%s\n' 'Use the committed fork release version without a desktop override.' >&2
  exit 1
fi
tag_commit=$(gh api "repos/greaber/t3code/commits/v$version" --jq .sha)
if [[ $tag_commit != "$head" ]]; then
  printf 'Fork release v%s is not the current commit.\n' "$version" >&2
  exit 1
fi
# SSH bootstrap downloads the CLI archives by the desktop version.
assets=$(gh release view "v$version" --repo greaber/t3code --json assets --jq '.assets[].name')
for asset in SHA256SUMS "t3-$version-linux-x64.tar.gz" "t3-$version-linux-arm64.tar.gz"; do
  if ! grep -Fxq "$asset" <<<"$assets"; then
    printf 'Publish %s on v%s before building the desktop app.\n' "$asset" "$version" >&2
    exit 1
  fi
done
exec vp run dist:desktop:dmg:arm64
