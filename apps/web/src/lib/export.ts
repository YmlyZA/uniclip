export function historyText(items: { text: string }[]): string {
  return items.map((i) => i.text).join("\n\n");
}

// Triggers a client-side .txt download. No-op outside a DOM (SSR / tests).
export function downloadTextFile(filename: string, content: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
