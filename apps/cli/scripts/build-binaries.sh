#!/bin/sh
# Cross-compile the uniclip CLI to standalone binaries (one per OS/arch) and
# write their SHA-256 checksums. Run from apps/cli (Bun fetches each target's
# runtime, so the build host needs network). TARGETS overridable for lean builds.
set -eu

TARGETS="${CLI_TARGETS:-darwin-arm64 darwin-x64 linux-x64 linux-arm64}"
OUT="dist/dl"
rm -rf "$OUT"
mkdir -p "$OUT"

# Root package.json's version, embedded into the binary via --define below.
# node -p resolves ../../package.json relative to this script's cwd (apps/cli/);
# falls back to `dev` if node is unavailable in the build image.
VERSION="$(node -p "require('../../package.json').version" 2>/dev/null || echo dev)"
GIT_SHA="${GIT_SHA:-dev}"

for t in $TARGETS; do
  echo "building uniclip-${t}..."
  bun build --compile --target="bun-$t" \
    --define "process.env.UNICLIP_VERSION=\"$VERSION\"" \
    --define "process.env.UNICLIP_GIT_SHA=\"$GIT_SHA\"" \
    src/bin.ts --outfile "$OUT/uniclip-$t"
done

# Portable sha256 (sha256sum on Linux/alpine, shasum on macOS).
( cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum uniclip-* > checksums.txt
  else
    shasum -a 256 uniclip-* > checksums.txt
  fi
)
echo "done -> $OUT"
cat "$OUT/checksums.txt"
