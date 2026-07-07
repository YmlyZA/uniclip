// Semver parse/compare (major.minor.patch; pre-release/build metadata ignored
// for comparison) — small enough to avoid a dependency.
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return false;
}

export interface UpdateSnapshot {
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
}

// Cached, stale-while-revalidate check. snapshot() returns the cache immediately
// and kicks off an async refresh when the cache is empty or older than ttlMs.
// Any fetch failure is swallowed — the relay must never crash on the update check.
export class UpdateChecker {
  private latest: string | null = null;
  private checkedAt: number | null = null;
  private refreshing = false;
  constructor(
    private readonly opts: {
      current: string;
      enabled: boolean;
      ttlMs: number;
      fetchLatest: () => Promise<string | null>;
      now?: () => number;
    },
  ) {}

  private nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  snapshot(): UpdateSnapshot {
    if (this.opts.enabled && this.isStale()) void this.refresh();
    return {
      latest: this.latest,
      updateAvailable: this.latest ? isNewer(this.latest, this.opts.current) : false,
      checkedAt: this.checkedAt,
    };
  }

  private isStale(): boolean {
    return this.checkedAt === null || this.nowMs() - this.checkedAt >= this.opts.ttlMs;
  }

  async refresh(): Promise<void> {
    if (!this.opts.enabled || this.refreshing) return;
    this.refreshing = true;
    try {
      const tag = await this.opts.fetchLatest();
      if (tag) this.latest = tag;
    } catch {
      /* graceful: keep any previously-known latest */
    } finally {
      this.checkedAt = this.nowMs();
      this.refreshing = false;
    }
  }
}

// Real GitHub Releases fetch. Returns the latest release tag (e.g. "v0.2.0") or
// null on any non-2xx / missing tag. Short timeout so a hung request can't wedge.
export async function fetchLatestRelease(repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "uniclip" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { tag_name?: string };
  return body.tag_name ?? null;
}
