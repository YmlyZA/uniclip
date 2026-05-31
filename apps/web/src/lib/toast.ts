import { writable } from "svelte/store";

export interface Toast {
  id: string;
  text: string;
  level: "info" | "warn" | "error";
  ttlMs: number;
}

export const toasts = writable<Toast[]>([]);

export function toast(text: string, level: Toast["level"] = "info", ttlMs = 4000): void {
  const id = crypto.randomUUID();
  toasts.update((arr) => [...arr, { id, text, level, ttlMs }]);
  setTimeout(() => {
    toasts.update((arr) => arr.filter((t) => t.id !== id));
  }, ttlMs);
}
