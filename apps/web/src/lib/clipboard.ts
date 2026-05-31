export async function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

export async function writeClipboardText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export interface ClipboardWatcherOptions {
  intervalMs?: number;
}

export class ClipboardWatcher {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: string | null = null;
  private listeners = new Set<(text: string) => void>();

  constructor(opts: ClipboardWatcherOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  on(cb: (text: string) => void): void {
    this.listeners.add(cb);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    let text: string;
    try {
      text = await readClipboardText();
    } catch {
      return;
    }
    if (text === this.last) return;
    this.last = text;
    for (const cb of this.listeners) cb(text);
  }
}
