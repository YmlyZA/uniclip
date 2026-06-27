#!/bin/sh
# Cross-compile the uniclip CLI to standalone binaries (one per OS/arch) and
# write their SHA-256 checksums. Run from apps/cli (Bun fetches each target's
# runtime, so the build host needs network). TARGETS overridable for lean builds.
set -eu

TARGETS="${CLI_TARGETS:-darwin-arm64 darwin-x64 linux-x64 linux-arm64}"
OUT="dist/dl"
rm -rf "$OUT"
mkdir -p "$OUT"

for t in $TARGETS; do
  echo "building uniclip-${t}..."
  bun build --compile --target="bun-$t" src/bin.ts --outfile "$OUT/uniclip-$t"
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
