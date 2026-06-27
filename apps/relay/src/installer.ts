// Renders the POSIX `sh` installer the relay serves at GET /setup.sh. The base
// URL and per-artifact sha256 checksums are templated in by the route, so the
// downloaded script knows where to fetch and can verify integrity (which also
// catches the static handler's SPA-HTML fallback for a wrong/missing artifact).
export function renderSetupScript(opts: { base: string; checksums: Record<string, string> }): string {
  // `base` is external input (the route derives it from the request Host header)
  // and is interpolated into a `curl|sh` script (high trust). Reject anything
  // that could break out of the quoted shell string: allow scheme + host +
  // optional :port + IPv6 brackets only — no quotes, `$`, backticks, `;`,
  // spaces, or paths.
  if (!/^https?:\/\/[\w.\-:\[\]]+$/.test(opts.base)) {
    throw new Error(`unsafe base URL: ${opts.base}`);
  }
  // Emit a shell case mapping "<os>-<arch>" → expected sha256.
  const cases = Object.entries(opts.checksums)
    .map(([name, sum]) => `    ${name.replace(/^uniclip-/, "")}) want="${sum}" ;;`)
    .join("\n");
  return `#!/bin/sh
# uniclip installer — downloads a standalone binary and installs it to ~/.local/bin.
set -eu

BASE="${opts.base}"

os=$(uname -s); arch=$(uname -m)
case "$os" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "Unsupported OS: $os" >&2; exit 1 ;; esac
case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "Unsupported arch: $arch" >&2; exit 1 ;; esac
key="$os-$arch"

want=""
case "$key" in
${cases}
  *) echo "No uniclip binary for $key" >&2; exit 1 ;;
esac

art="uniclip-$key"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
echo "Downloading $art..."
curl -fSL "$BASE/dl/$art" -o "$tmp"

# Verify integrity (also rejects an HTML SPA-fallback served for a missing file).
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp" | cut -d' ' -f1); fi
if [ "$got" != "$want" ]; then echo "Checksum mismatch for $art (got $got, want $want) — aborting." >&2; exit 1; fi

dest="$HOME/.local/bin"
mkdir -p "$dest"
chmod +x "$tmp"
mv "$tmp" "$dest/uniclip"
trap - EXIT
echo "Installed $dest/uniclip"
case ":$PATH:" in *":$dest:"*) echo "Run: uniclip" ;; *) echo "Add to PATH:  export PATH=\\"$dest:\\$PATH\\"   then run: uniclip" ;; esac
`;
}
