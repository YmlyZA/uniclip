import clipboard from "clipboardy";

// Writes to the OS clipboard. Never throws — a failure (no clipboard tool on
// the host) returns false so the UI can show a transient message.
export async function copyToClipboard(
  text: string,
  writer: (t: string) => Promise<void> = (t) => clipboard.write(t),
): Promise<boolean> {
  try {
    await writer(text);
    return true;
  } catch {
    return false;
  }
}
