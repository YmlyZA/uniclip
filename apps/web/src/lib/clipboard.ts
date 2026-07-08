export async function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

export async function writeClipboardText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/** A filename for a clipboard image, derived from its MIME subtype
 * (image/svg+xml → clipboard-image.svg). The async Clipboard API gives us a
 * blob with no name, but sendFile needs one. */
export function filenameForImageType(type: string): string {
  const ext = type.split("/")[1]?.split("+")[0] || "png";
  return `clipboard-image.${ext}`;
}

/**
 * Read an image off the clipboard via the async Clipboard API and return it as
 * a File so it can be staged/sent exactly like a pasted image. Returns null
 * when the clipboard holds no image, the API is unavailable, or permission is
 * denied — letting callers fall back to readClipboardText. This is what makes
 * the "Fill from clipboard" button behave like Ctrl/⌘+V (the only image entry
 * point on iOS, which has no paste shortcut).
 */
/**
 * Read the clipboard in a single navigator.clipboard.read() call, returning
 * both an image (if any) and text from the SAME read. Doing one round-trip
 * matters on Safari/iOS: a read()-then-readText() sequence spends the user
 * activation on the first call and triggers a second permission prompt, so the
 * text fallback silently fails. Falls back to readText() only when read() isn't
 * available, and never throws. `denied` is true only when every access attempt
 * threw (permission/unsupported) — distinct from an accessible-but-empty
 * clipboard ({ ..., denied: false }) so callers don't cry "blocked" on empty.
 */
export async function readClipboard(): Promise<{ image: File | null; text: string; denied: boolean }> {
  const read = navigator.clipboard?.read?.bind(navigator.clipboard);
  if (read) {
    try {
      const items = await read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        try {
          const blob = await item.getType(type);
          return { image: new File([blob], filenameForImageType(type), { type }), text: "", denied: false };
        } catch {
          // advertised but unreadable (e.g. SVG); keep scanning
        }
      }
      for (const item of items) {
        if (!item.types.includes("text/plain")) continue;
        try {
          return { image: null, text: await (await item.getType("text/plain")).text(), denied: false };
        } catch {
          /* fall through */
        }
      }
      return { image: null, text: "", denied: false }; // accessible, just empty
    } catch {
      // read() denied/unsupported — try the simpler text path below
    }
  }
  try {
    return { image: null, text: await navigator.clipboard.readText(), denied: false };
  } catch {
    return { image: null, text: "", denied: true }; // every path threw → blocked
  }
}

export async function readClipboardImage(): Promise<File | null> {
  const read = navigator.clipboard?.read?.bind(navigator.clipboard);
  if (!read) return null;
  let items: Awaited<ReturnType<typeof read>>;
  try {
    items = await read();
  } catch {
    return null; // permission denied, no transient activation, or unsupported
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      return new File([blob], filenameForImageType(type), { type });
    } catch {
      continue; // this item advertised an image type but won't serve it; try the next
    }
  }
  return null;
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
    // Probe clipboard readability once before arming the interval: tick()
    // swallows read failures (so it can retry silently on transient errors),
    // which meant a denied permission never surfaced anywhere. Rejecting here
    // lets callers (toggleWatch) catch it and toast. Intentionally not seeding
    // `this.last` from the probe result — that would suppress the "send
    // current clipboard on first change" behavior tick() relies on.
    await readClipboardText();
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
