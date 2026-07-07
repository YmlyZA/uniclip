// Pure formatting for the footer (tested in node; the .svelte shell just renders these).
export function formatVersion(v: { version: string; gitSha: string }): string {
  return v.gitSha && v.gitSha !== "dev" ? `v${v.version} (${v.gitSha})` : `v${v.version}`;
}

export function updateLabel(v: { updateAvailable: boolean; latest: string | null }): string | null {
  if (!v.updateAvailable || !v.latest) return null;
  const tag = v.latest.startsWith("v") ? v.latest : `v${v.latest}`;
  return `Update available: ${tag}`;
}

export function releasesUrl(repo = "YmlyZA/uniclip"): string {
  return `https://github.com/${repo}/releases`;
}
